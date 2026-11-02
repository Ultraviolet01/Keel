// The vault's own address on Base, controlled through NEAR Chain Signatures.
// Read-only here: the vault builds and signs transfers; the agent broadcasts.

import { keccak_256 } from "@noble/hashes/sha3";
import { view } from "./near";

export interface EvmRoute {
  chain_id: number;
  token: string;
  max_fee_per_gas: string;
  max_gas: number;
}

export const EVM_CHAINS: Record<number, { name: string; rpc: string; explorer: string }> = {
  84532: { name: "Base Sepolia", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  8453: { name: "Base", rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
};

export interface EvmWallet {
  route: EvmRoute;
  address: string;
  usdc: bigint;
  eth: bigint;
  chain: { name: string; rpc: string; explorer: string };
}

/** The vault's EVM wallet, or null for vaults created before Chain Signatures or with the route off. */
export async function evmWallet(vaultId: string): Promise<EvmWallet | null> {
  const info = await view<{ route: EvmRoute | null; mpc_id: string; path: string }>(vaultId, "get_evm_route").catch(() => null);
  if (!info?.route) return null;
  const chain = EVM_CHAINS[info.route.chain_id];
  if (!chain) return null;
  const pk = await view<string>(info.mpc_id, "derived_public_key", { path: info.path, predecessor: vaultId, domain_id: 0 });
  const address = addressFromNearKey(pk);
  const [usdc, eth] = await Promise.all([
    evmRpc(chain.rpc, "eth_call", [{ to: info.route.token, data: `0x70a08231${address.slice(2).padStart(64, "0")}` }, "latest"]),
    evmRpc(chain.rpc, "eth_getBalance", [address, "latest"]),
  ]).catch(() => ["0x0", "0x0"]);
  return { route: info.route, address, usdc: BigInt(usdc === "0x" ? "0x0" : usdc), eth: BigInt(eth), chain };
}

async function evmRpc(url: string, method: string, params: unknown[]): Promise<string> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function addressFromNearKey(pk: string): string {
  let n = 0n;
  for (const ch of pk.replace(/^secp256k1:/, "")) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  const point = new Uint8Array(64);
  for (let i = 63; i >= 0; i--) {
    point[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  const hash = keccak_256(point);
  return `0x${Array.from(hash.slice(-20), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
