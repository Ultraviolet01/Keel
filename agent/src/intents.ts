// NEAR Intents 1Click API: cross-chain moves.
// Docs: https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api
//
// Flow for Keel: look up the tokens, get a quote (dry to preview, real to get a
// deposit address), have the vault pay that address, then poll status until it
// is SUCCESS, REFUNDED or FAILED. 1Click only runs on mainnet.

const BASE = process.env.ONECLICK_URL || "https://1click.chaindefuser.com";

export interface Token {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  contractAddress: string | null;
}

export interface QuoteRequest {
  dry: boolean;
  originAsset: string;
  destinationAsset: string;
  amount: string; // smallest unit of the origin asset
  recipient: string;
  refundTo: string;
  deadline: string; // ISO time
  slippageTolerance?: number; // basis points
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  deadline?: string; // after this the deposit address is inactive and funds may be lost
  timeEstimate?: number; // seconds after the deposit confirms
}

export type SwapStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "INCOMPLETE_DEPOSIT" | "REFUNDED" | "FAILED";
export const FINAL: SwapStatus[] = ["SUCCESS", "REFUNDED", "FAILED"];

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const jwt = process.env.ONECLICK_JWT;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click ${path} answered HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

export function tokens() {
  return call<Token[]>("/v0/tokens");
}

/** Finds a token by chain and symbol, for example ("base", "USDC"). */
export async function findToken(blockchain: string, symbol: string): Promise<Token> {
  const all = await tokens();
  const t = all.find((x) => x.blockchain === blockchain && x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!t) throw new Error(`1Click lists no ${symbol} on ${blockchain}`);
  return t;
}

/** Builds the 1Click quote body: exact input, deposit on the origin chain, refunds to the vault. */
export function quoteBody(q: QuoteRequest) {
  return {
    dry: q.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: q.slippageTolerance ?? 100,
    originAsset: q.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: q.destinationAsset,
    amount: q.amount,
    recipient: q.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: q.refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: q.deadline,
  };
}

export async function quote(q: QuoteRequest): Promise<Quote> {
  const r = await call<{ quote: Quote }>("/v0/quote", { method: "POST", body: JSON.stringify(quoteBody(q)) });
  return r.quote;
}

export async function status(depositAddress: string, depositMemo?: string): Promise<SwapStatus> {
  const qs = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
  const r = await call<{ status: SwapStatus }>(`/v0/status?${qs}`);
  return r.status;
}

/** Optional: tells 1Click about the deposit transaction to speed things up. */
export async function submitDeposit(depositAddress: string, txHash: string) {
  await call("/v0/deposit/submit", { method: "POST", body: JSON.stringify({ depositAddress, txHash }) });
}

/** The deadline to ask for, leaving the owner time to approve. */
export function deadlineFromNow(minutes: number, now = Date.now()): string {
  return new Date(now + minutes * 60_000).toISOString();
}
