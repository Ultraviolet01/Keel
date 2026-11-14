// Independent check of a NEAR Intents (1Click) deposit address before the
// owner approves paying it. The vault only sees the deposit address, and
// Keel's reason is written by the agent, so the app asks 1Click itself where
// that address pays. A compromised agent cannot change 1Click's answer.

export const ONECLICK_URL = "https://1click.chaindefuser.com";

export type DepositCheck =
  | { kind: "loading" }
  | { kind: "unreachable"; detail: string }
  | { kind: "unknown" }
  | {
      kind: "known";
      recipient: string;
      chain: string;
      token: string;
      amountOut: string;
      refundTo: string;
      status: string;
      problems: string[];
    };

/**
 * USDC on each chain a bill can be on, as 1Click names it (GET /v0/tokens, 14 Nov 2026). Keel's agent
 * always asks 1Click for exactly the bill's amount of this asset, so an approval needs nothing else.
 */
/** 1Click's own fee on a genuine quote is 1 basis point (0.01%); more is someone else's cut. */
export const MAX_FEE_BPS = 10;

export const USDC_ASSET: Record<string, string> = {
  eth: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  arb: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  base: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  op: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ",
};

/** "nep141:base-0x8335….omft.near" -> "base"; Optimism's USDC -> "op"; "nep141:wrap.near" -> "near". */
export function chainOfAsset(assetId: string): string {
  const known = Object.entries(USDC_ASSET).find(([, a]) => a === assetId);
  if (known) return known[0];
  const id = assetId.replace(/^nep\d+:/, "");
  const m = id.match(/^([a-z0-9]+)-.+\.omft\.near$/);
  return m ? m[1] : "near";
}

/**
 * Judges a /v0/status reply against the proposal the owner is about to approve.
 * `httpStatus` 404 means 1Click has never issued this deposit address.
 */
export function assessDeposit(
  httpStatus: number,
  body: unknown,
  proposal: { amount: string },
  vaultId: string,
  /** The bill this proposal says it pays; 1Click must pay that bill's payee, its amount of USDC, on its chain. */
  bill?: { payee: string; chain?: string | null; amount?: string } | null,
  /** The vault's own token: the quote must expect exactly that as its deposit. */
  tokenId?: string,
): DepositCheck {
  if (httpStatus === 404) return { kind: "unknown" };
  if (httpStatus < 200 || httpStatus >= 300 || !body || typeof body !== "object") {
    return { kind: "unreachable", detail: `1Click answered HTTP ${httpStatus}` };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = body as Record<string, any>;
  const req = b.quoteResponse?.quoteRequest ?? {};
  const quote = b.quoteResponse?.quote ?? {};
  const recipient = String(req.recipient ?? "");
  const refundTo = String(req.refundTo ?? "");
  const problems: string[] = [];
  if (!recipient) problems.push("1Click's record has no recipient");
  // A stolen agent key could file a real 1Click quote that pays its own address: compare, not just show.
  if (!bill) problems.push("this proposal names no bill Keel can find, so where 1Click pays cannot be checked");
  else {
    if (recipient && recipient.toLowerCase() !== bill.payee.toLowerCase()) problems.push(`1Click would pay ${recipient}, but the bill pays ${bill.payee}`);
    const asset = String(req.destinationAsset ?? "");
    const want = bill.chain ? USDC_ASSET[bill.chain] : undefined;
    if (!want) problems.push(`Keel does not know USDC on ${bill.chain ?? "this bill's chain"}, so what 1Click pays cannot be checked`);
    else if (asset !== want) problems.push(`1Click would pay ${asset.replace(/^nep\d+:/, "") || "an unknown token"} on ${chainOfAsset(asset)}, but the bill is USDC on ${bill.chain}`);
    // How the quote moves money, as Keel's agent always asks for it: deposit and refund on the vault's
    // own chain account (an INTENTS refund would strand money the vault cannot withdraw), delivery on
    // the payee's chain, exact output, no redirection, and no fee beyond 1Click's own small one.
    const expect: [string, string][] = [["depositType", "ORIGIN_CHAIN"], ["refundType", "ORIGIN_CHAIN"], ["recipientType", "DESTINATION_CHAIN"], ["swapType", "EXACT_OUTPUT"]];
    for (const [k, v] of expect) if (req[k] !== v) problems.push(`the quote's ${k} is ${String(req[k] ?? "missing")}, not ${v} as Keel asks`);
    // The deposit side: the vault's own token, a plain deposit, to an address still waiting for one.
    if (tokenId && req.originAsset !== `nep141:${tokenId}`) problems.push(`the quote expects ${String(req.originAsset ?? "an unknown token")}, but the vault pays ${tokenId}`);
    if (req.depositMode !== undefined && req.depositMode !== "SIMPLE") problems.push(`the quote needs a ${String(req.depositMode)} deposit, which the vault cannot make`);
    if (b.status !== "PENDING_DEPOSIT") problems.push(`this deposit address is ${String(b.status ?? "in an unknown state")}, not waiting for a deposit`);
    for (const k of ["virtualChainRecipient", "virtualChainRefundRecipient"]) if (req[k]) problems.push(`the quote redirects funds through ${k}`);
    const fees = Array.isArray(req.appFees) ? req.appFees : [];
    const bps = fees.reduce((t: number, f: { fee?: unknown }) => t + (Number(f?.fee) || 0), 0);
    if (bps > MAX_FEE_BPS) problems.push(`the quote takes ${(bps / 100).toFixed(2)}% in fees for ${fees.map((f: { recipient?: unknown }) => String(f?.recipient ?? "?")).join(", ")}`);
    // Keel asks for exactly the bill's amount out; less means the payee would be short-changed.
    const out = String(quote.amountOut ?? "");
    if (bill.amount && !(/^\d+$/.test(out) && BigInt(out) >= BigInt(bill.amount))) problems.push(`1Click would deliver ${quote.amountOutFormatted ?? (out || "an unknown amount")}, less than the bill`);
  }
  if (refundTo !== vaultId) problems.push(`refunds would go to ${refundTo || "nobody"}, not this vault`);
  if (quote.amountIn !== undefined && String(quote.amountIn) !== String(proposal.amount)) {
    problems.push(`the quote expects ${quote.amountIn} units in, but this proposal pays ${proposal.amount}`);
  }
  return {
    kind: "known",
    recipient,
    chain: chainOfAsset(String(req.destinationAsset ?? "")),
    token: String(req.destinationAsset ?? "").replace(/^nep\d+:/, ""),
    amountOut: String(quote.amountOutFormatted ?? quote.amountOut ?? "?"),
    refundTo,
    status: String(b.status ?? "?"),
    problems,
  };
}

export async function checkDeposit(depositAddress: string, proposal: { amount: string }, vaultId: string, bill?: { payee: string; chain?: string | null; amount?: string } | null, tokenId?: string): Promise<DepositCheck> {
  try {
    const res = await fetch(`${ONECLICK_URL}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    return assessDeposit(res.status, body, proposal, vaultId, bill, tokenId);
  } catch (e) {
    return { kind: "unreachable", detail: String(e instanceof Error ? e.message : e).slice(0, 120) };
  }
}
