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

/** "nep141:base-0x8335….omft.near" -> "base"; "nep141:wrap.near" -> "near". */
export function chainOfAsset(assetId: string): string {
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
  /** The bill this proposal says it pays; 1Click must pay that bill's payee, on its chain. */
  bill?: { payee: string; chain?: string | null } | null,
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
    const chain = chainOfAsset(String(req.destinationAsset ?? ""));
    if (bill.chain && chain !== bill.chain) problems.push(`1Click would pay on ${chain}, but the bill is on ${bill.chain}`);
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

export async function checkDeposit(depositAddress: string, proposal: { amount: string }, vaultId: string, bill?: { payee: string; chain?: string | null } | null): Promise<DepositCheck> {
  try {
    const res = await fetch(`${ONECLICK_URL}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    return assessDeposit(res.status, body, proposal, vaultId, bill);
  } catch (e) {
    return { kind: "unreachable", detail: String(e instanceof Error ? e.message : e).slice(0, 120) };
  }
}
