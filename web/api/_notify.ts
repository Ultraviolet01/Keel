// Email notifications: who signed up (kept private in Vercel Blob), proof
// that a wallet is theirs (NEP-413 signed messages), sending mail through
// Gmail, and reading each vault from NEAR. Used by api/notify.ts.

import { del, get, list, put } from "@vercel/blob";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58, base64 } from "@scure/base";
import nodemailer from "nodemailer";
import type { DaoVote, Transfer, VaultPolicy, VaultProposal } from "./_alerts.js";

export const NETWORK = process.env.KEEL_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const FACTORY = process.env.KEEL_FACTORY ?? (NETWORK === "mainnet" ? "keel.near" : "keel.testnet");
const RPC = NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com";
const NEARBLOCKS = NETWORK === "mainnet" ? "https://api.nearblocks.io" : "https://api-testnet.nearblocks.io";
export const APP_URL = (process.env.KEEL_APP_URL ?? "https://keel-treasury.vercel.app").replace(/\/$/, "");
/** The NEP-413 recipient every Keel notification message names. */
export const RECIPIENT = "keel-notifications";

// ------------------------------------------------------------------ chain

async function rpc<T>(params: object): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { result?: T & { error?: string }; error?: { data?: string; message?: string } };
  if (body.error) throw new Error(String(body.error.data ?? body.error.message));
  if (body.result?.error) throw new Error(body.result.error);
  return body.result as T;
}

export async function view<T>(account: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>({
    request_type: "call_function",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}

/** True if `publicKey` is a full-access key of `account`: only its owner holds one. */
export async function isFullAccessKey(account: string, publicKey: string): Promise<boolean> {
  try {
    const k = await rpc<{ permission: unknown }>({ request_type: "view_access_key", account_id: account, public_key: publicKey });
    return k.permission === "FullAccess";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------- signed messages

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const str = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  return [u32(bytes.length), bytes];
};
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

/** The bytes a NEP-413 wallet signs: sha256 of the tag 2^31 + 413, then the borsh payload. */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  return sha256(concat([u32(2 ** 31 + 413), ...str(message), nonce, ...str(recipient), new Uint8Array([0])]));
}

const keyBytes = (publicKey: string) => {
  if (!publicKey.startsWith("ed25519:")) throw new Error("only ed25519 keys are supported");
  return base58.decode(publicKey.slice(8));
};
const sigBytes = (signature: string) => {
  const s = signature.replace(/^ed25519:/, "");
  try {
    const b = base64.decode(s);
    if (b.length === 64) return b;
  } catch {
    /* not base64 */
  }
  return base58.decode(s);
};

export interface SignedRequest {
  accountId: string;
  publicKey: string;
  signature: string;
  message: string;
  /** base64 of the 32-byte nonce */
  nonce: string;
}

/**
 * Checks a message the wallet signed: the signature, that the key is one of
 * the account's full-access keys, that it names this account and the action,
 * and that it is less than ten minutes old. Returns the message's fields.
 */
export async function verifySigned(r: SignedRequest, action: string, now = Date.now()): Promise<Record<string, string>> {
  if (!r || typeof r.message !== "string" || typeof r.accountId !== "string") throw new Error("Sign the message with your wallet first.");
  const nonce = base64.decode(r.nonce);
  if (nonce.length !== 32) throw new Error("The signed message needs a 32-byte nonce.");
  const ok = ed25519.verify(sigBytes(r.signature), nep413Hash(r.message, nonce, RECIPIENT), keyBytes(r.publicKey));
  if (!ok) throw new Error("The signature does not match the message.");
  const fields = Object.fromEntries(
    r.message
      .split("\n")
      .map((l) => l.match(/^([A-Za-z]+): (.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1].toLowerCase(), m[2].trim()]),
  );
  if (fields.account !== r.accountId) throw new Error("The message names another account.");
  if (fields.action !== action) throw new Error("The message asks for something else.");
  const at = Date.parse(fields.time ?? "");
  if (!Number.isFinite(at) || Math.abs(now - at) > 10 * 60_000) throw new Error("The signed message is too old. Sign again.");
  if (!(await isFullAccessKey(r.accountId, r.publicKey))) throw new Error("That key is not one of this account's full-access keys.");
  return fields;
}

/** Keel's agent signs each round's report with its key; anyone can check it against the factory's record. */
export async function verifyAgent(body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const { agent_key } = await view<{ agent_key: string }>(FACTORY, "get_config");
  try {
    return ed25519.verify(sigBytes(signature), new TextEncoder().encode(body), keyBytes(agent_key));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- private store

export interface Subscriber {
  account: string;
  email: string;
  confirmed: boolean;
  /** For the confirm link (until confirmed) and the unsubscribe link. */
  confirmToken: string;
  unsubToken: string;
  createdAt: number;
  lastTestAt?: number;
  digestDay?: string;
  digestAt?: number;
}

export async function readJson<T>(path: string): Promise<T | null> {
  const r = await get(path, { access: "private", useCache: false }).catch(() => null);
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return JSON.parse(await new Response(r.stream).text()) as T;
}

export async function writeJson(path: string, value: unknown) {
  await put(path, JSON.stringify(value), { access: "private", allowOverwrite: true, addRandomSuffix: false, contentType: "application/json" });
}

export async function removeJson(path: string) {
  await del(path).catch(() => {});
}

const subPath = (account: string) => `subs/${account}.json`;
export const getSub = (account: string) => readJson<Subscriber>(subPath(account));
export const saveSub = (s: Subscriber) => writeJson(subPath(s.account), s);
export const tokenPath = (token: string) => `tokens/${token}.json`;

export async function allSubs(): Promise<Subscriber[]> {
  const out: Subscriber[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: "subs/", cursor, limit: 1000 });
    for (const b of page.blobs) {
      const s = await readJson<Subscriber>(b.pathname);
      if (s) out.push(s);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

export function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

export const maskEmail = (e: string) => e.replace(/^(.)(.*)(@.*)$/, (_, a: string, b: string, c: string) => `${a}${"*".repeat(Math.min(b.length, 6))}${c}`);

// ------------------------------------------------------------------- mail

export const mailReady = () => Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

export async function sendMail(to: string, subject: string, body: { text: string; html: string }) {
  if (!mailReady()) throw new Error("Email is not set up on this deployment (GMAIL_USER and GMAIL_APP_PASSWORD).");
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transport.sendMail({ from: `Keel <${process.env.GMAIL_USER}>`, to, subject, text: body.text, html: body.html });
}

// ------------------------------------------------------------------ vaults

export interface Team {
  /** Every member of the multisig. */
  members: string[];
  /** Members whose role may vote on function calls. */
  voters: string[];
}

type DaoPolicy = { proposal_bond?: string; roles?: { kind: string | { Group?: string[] }; permissions?: string[] }[] };

/** The members and voters of `account` if it is a Sputnik DAO multisig, else null. */
export async function teamOf(account: string): Promise<Team | null> {
  const p = await view<DaoPolicy>(account, "get_policy").catch(() => null);
  if (!p || typeof p.proposal_bond !== "string" || !Array.isArray(p.roles)) return null;
  const groups = p.roles.filter((r) => typeof r.kind === "object" && r.kind.Group) as { kind: { Group: string[] }; permissions?: string[] }[];
  const members = [...new Set(groups.flatMap((r) => r.kind.Group))];
  const votes = (perms: string[] = []) => perms.some((x) => /^(\*|call):(\*|VoteApprove)$/.test(x));
  const voters = [...new Set(groups.filter((r) => votes(r.permissions)).flatMap((r) => r.kind.Group))];
  return { members, voters };
}

/** Every vault the factory created, with its owner. */
export async function vaultOwners(): Promise<Map<string, string>> {
  const vaults: string[] = [];
  for (let from = 0; from < 5000; from += 100) {
    const page = await view<string[]>(FACTORY, "get_vaults", { from_index: from, limit: 100 });
    vaults.push(...page);
    if (page.length < 100) break;
  }
  const owners = await Promise.all(vaults.map((v) => view<string | null>(FACTORY, "get_owner", { vault_id: v }).catch(() => null)));
  return new Map(vaults.map((v, i) => [v, owners[i] ?? ""]).filter(([, o]) => o) as [string, string][]);
}

export interface VaultView {
  policy: VaultPolicy & { token_id: string };
  proposals: VaultProposal[];
  dao: DaoVote[];
  balance: bigint;
  decimals: number;
  symbol: string;
  names: Record<string, string>;
}

export async function readVault(vault: string, dao: boolean): Promise<VaultView> {
  const policy = await view<VaultPolicy & { token_id: string }>(vault, "get_policy");
  const [proposals, balance, meta, payees] = await Promise.all([
    view<VaultProposal[]>(vault, "get_proposals", { from_index: 0, limit: 100 }),
    view<string>(policy.token_id, "ft_balance_of", { account_id: vault }),
    view<{ symbol: string; decimals: number }>(policy.token_id, "ft_metadata"),
    view<{ account_id: string; name: string }[]>(vault, "get_payees").catch(() => []),
  ]);
  let open: DaoVote[] = [];
  if (dao) {
    const last = await view<number>(policy.owner_id, "get_last_proposal_id");
    const list = await view<{ id: number; proposer: string; status: string; votes: Record<string, string>; kind: { FunctionCall?: { receiver_id: string; actions: { method_name: string }[] } } }[]>(
      policy.owner_id,
      "get_proposals",
      { from_index: Math.max(0, last - 60), limit: 60 },
    );
    open = list
      .filter((p) => p.status === "InProgress" && p.kind.FunctionCall?.receiver_id === vault)
      .map((p) => ({ id: p.id, proposer: p.proposer, votes: p.votes, methods: [...new Set(p.kind.FunctionCall!.actions.map((a) => a.method_name))] }));
  }
  return { policy, proposals, dao: open, balance: BigInt(balance), decimals: meta.decimals, symbol: meta.symbol, names: Object.fromEntries(payees.map((p) => [p.account_id, p.name])) };
}

/** The vault's token transfers (newest page) from nearblocks' public index; empty if it cannot be read. */
export async function transfers(vault: string, tokenId: string): Promise<Transfer[]> {
  try {
    const res = await fetch(`${NEARBLOCKS}/v3/accounts/${vault}/ft-txns?per_page=50`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { contract_account_id: string; delta_amount: string; block_timestamp: string; involved_account_id?: string | null }[] };
    return (body.data ?? [])
      .filter((t) => t.contract_account_id === tokenId)
      .map((t) => ({ at: Number(BigInt(t.block_timestamp) / 1_000_000n), delta: BigInt(t.delta_amount), counterparty: t.involved_account_id ?? "unknown" }));
  } catch {
    return [];
  }
}
