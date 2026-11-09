// The vault's own address on Base, controlled through NEAR Chain Signatures.
// Read-only here: the vault builds and signs transfers; the agent broadcasts.

import { keccak_256 } from "@noble/hashes/sha3";
import { view } from "./near";

export interface EvmRoute {
  chain_id: number;
  token: string;
  decimals?: number;
  max_fee_per_gas: string;
  max_gas: number;
  /** Bills on this chain up to this amount (vault token units) to an allowlisted 0x payee are paid without asking. */
  auto_cap?: string | null;
}

export const EVM_CHAINS: Record<number, { name: string; rpc: string; explorer: string; gas: string }> = {
  84532: { name: "Base Sepolia", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", gas: "ETH" },
  8453: { name: "Base", rpc: "https://mainnet.base.org", explorer: "https://basescan.org", gas: "ETH" },
  11155111: { name: "Ethereum Sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io", gas: "ETH" },
  1: { name: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io", gas: "ETH" },
  421614: { name: "Arbitrum Sepolia", rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io", gas: "ETH" },
  42161: { name: "Arbitrum", rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io", gas: "ETH" },
  11155420: { name: "Optimism Sepolia", rpc: "https://sepolia.optimism.io", explorer: "https://sepolia-optimism.etherscan.io", gas: "ETH" },
  10: { name: "Optimism", rpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io", gas: "ETH" },
};

export interface EvmChainBalance {
  route: EvmRoute;
  chain: { name: string; rpc: string; explorer: string; gas: string };
  usdc: bigint;
  gas: bigint;
}

export interface EvmWallet {
  address: string;
  chains: EvmChainBalance[];
}

/** The vault's EVM address (the same on every chain) and its balance on each route, or null. */
export async function evmWallet(vaultId: string): Promise<EvmWallet | null> {
  const info = await view<{ routes?: EvmRoute[]; route?: EvmRoute | null; mpc_id: string; path: string }>(vaultId, "get_evm_route").catch(() => null);
  const routes = (info?.routes ?? (info?.route ? [info.route] : [])).filter((r) => EVM_CHAINS[r.chain_id]);
  if (!info || routes.length === 0) return null;
  const pk = await view<string>(info.mpc_id, "derived_public_key", { path: info.path, predecessor: vaultId, domain_id: 0 });
  const address = addressFromNearKey(pk);
  const chains = await Promise.all(
    routes.map(async (route) => {
      const chain = EVM_CHAINS[route.chain_id];
      const [usdc, gas] = await Promise.all([
        evmRpc(chain.rpc, "eth_call", [{ to: route.token, data: `0x70a08231${address.slice(2).padStart(64, "0")}` }, "latest"]),
        evmRpc(chain.rpc, "eth_getBalance", [address, "latest"]),
      ]).catch(() => ["0x0", "0x0"]);
      return { route: { ...route, decimals: route.decimals ?? 6 }, chain, usdc: BigInt(usdc === "0x" ? "0x0" : usdc), gas: BigInt(gas) };
    }),
  );
  return { address, chains };
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
