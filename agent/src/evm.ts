// The vault's own address on an EVM chain (Base), controlled through NEAR
// Chain Signatures. The vault builds and hashes the USDC transfer itself and
// asks NEAR's MPC network to sign it after the owner approves; Keel only
// reads the chain, fills in nonce and fees, and broadcasts the signed bytes
// the vault stores. No third-party bridge or API is involved.

import { createPublicClient, erc20Abi, formatUnits, http, keccak256, type Hex } from "viem";
import type { Chain } from "./chain";

export interface EvmRoute {
  chain_id: number;
  token: string;
  max_fee_per_gas: string;
  max_gas: number;
}

export interface EvmTransfer {
  chain_id: number;
  token: string;
  to: string;
  nonce: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  gas_limit: number;
}

const NAMES: Record<number, { name: string; rpc: string; explorer: string }> = {
  84532: { name: "base", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  8453: { name: "base", rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
};

export function chainInfo(chainId: number) {
  const c = NAMES[chainId];
  if (!c) throw new Error(`no RPC configured for EVM chain ${chainId}`);
  return { ...c, rpc: process.env[`EVM_RPC_${chainId}`] || c.rpc };
}

export function client(chainId: number) {
  return createPublicClient({ transport: http(chainInfo(chainId).rpc, { timeout: 20_000 }) });
}

/** The vault's EVM route, or null for vaults created before Chain Signatures. */
export async function vaultRoute(chain: Chain, vaultId: string) {
  try {
    return await chain.view<{ route: EvmRoute | null; mpc_id: string; path: string; predecessor: string }>(vaultId, "get_evm_route");
  } catch {
    return null;
  }
}

/** The vault's EVM address, derived by NEAR's MPC contract from the vault account and path. */
export async function vaultAddress(chain: Chain, mpcId: string, vaultId: string, path: string): Promise<Hex> {
  const pk = await chain.view<string>(mpcId, "derived_public_key", { path, predecessor: vaultId, domain_id: 0 });
  return addressFromNearKey(pk);
}

/** "secp256k1:<base58 of the 64-byte uncompressed point>" to a 0x address. */
export function addressFromNearKey(pk: string): Hex {
  const bytes = base58(pk.replace(/^secp256k1:/, ""));
  if (bytes.length !== 64) throw new Error(`unexpected public key length ${bytes.length}`);
  return `0x${keccak256(bytes).slice(-40)}`;
}

/** Both route tokens (USDC on Base and Base Sepolia) have 6 decimals. */
export const usdc = (units: bigint) => `${formatUnits(units, 6)} USDC`;

export async function balances(chainId: number, token: string, owner: Hex) {
  const c = client(chainId);
  const [usdc, eth] = await Promise.all([
    c.readContract({ address: token as Hex, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    c.getBalance({ address: owner }),
  ]);
  return { usdc, eth };
}

/**
 * Fills in the fields the vault needs. `queued` is how many earlier EVM
 * proposals from this vault are still waiting, so each gets its own nonce.
 */
export async function prepareTransfer(route: EvmRoute, from: Hex, to: string, amount: bigint, queued: number): Promise<EvmTransfer> {
  const c = client(route.chain_id);
  const [nonce, fees, gas] = await Promise.all([
    c.getTransactionCount({ address: from, blockTag: "pending" }),
    c.estimateFeesPerGas(),
    c
      .estimateContractGas({ address: route.token as Hex, abi: erc20Abi, functionName: "transfer", args: [to as Hex, amount], account: from })
      .catch(() => 65_000n),
  ]);
  const cap = BigInt(route.max_fee_per_gas);
  // Double the current fee for headroom while the owner approves, within the vault's cap.
  const maxFee = fees.maxFeePerGas * 2n > cap ? cap : fees.maxFeePerGas * 2n;
  if (fees.maxFeePerGas > cap) throw new Error(`fees on chain ${route.chain_id} are above the vault's cap right now`);
  const priority = fees.maxPriorityFeePerGas > maxFee ? maxFee : fees.maxPriorityFeePerGas;
  const gasLimit = Math.min(Number((gas * 13n) / 10n), route.max_gas);
  return {
    chain_id: route.chain_id,
    token: route.token,
    to: to.toLowerCase(),
    nonce: nonce + queued,
    max_fee_per_gas: maxFee.toString(),
    max_priority_fee_per_gas: priority.toString(),
    gas_limit: gasLimit,
  };
}

/**
 * Sends the bytes the vault stored. Safe to repeat: an already-known tx is not
 * an error. Returns "stale" when its nonce was already used by another
 * transaction, so it can never land and the bill must be proposed again.
 */
export async function broadcast(chainId: number, rawTx: Hex, txHash: Hex): Promise<"sent" | "stale"> {
  const c = client(chainId);
  try {
    await c.sendRawTransaction({ serializedTransaction: rawTx });
  } catch (e) {
    const known = await c.getTransaction({ hash: txHash }).catch(() => null);
    if (known) return "sent";
    if (/nonce too low|nonce.*already been used/i.test(String(e))) return "stale";
    throw e;
  }
  return "sent";
}

/** SUCCESS, FAILED, or null while the transaction is not mined yet. */
export async function receipt(chainId: number, txHash: Hex): Promise<"SUCCESS" | "FAILED" | null> {
  const r = await client(chainId).getTransactionReceipt({ hash: txHash }).catch(() => null);
  return r ? (r.status === "success" ? "SUCCESS" : "FAILED") : null;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  const zeros = s.match(/^1*/)![0].length;
  return new Uint8Array([...new Uint8Array(zeros), ...body]);
}
