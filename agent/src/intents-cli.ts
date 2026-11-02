// npm run intents -- tokens [SYMBOL]
// npm run intents -- quote --to base --amount 5 --recipient 0x... --refund your.near   (dry, nothing is sent)
// npm run intents -- status <depositAddress>

import { deadlineFromNow, findToken, quote, status, tokens } from "./intents";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};

if (cmd === "tokens") {
  const symbol = rest[0]?.toUpperCase();
  for (const t of await tokens()) {
    if (!symbol || t.symbol.toUpperCase() === symbol) console.log(`${t.blockchain.padEnd(8)} ${t.symbol.padEnd(8)} ${t.decimals}  ${t.assetId}`);
  }
} else if (cmd === "quote") {
  const symbol = opt("token", "USDC")!;
  const from = await findToken(opt("from", "near")!, symbol);
  const to = await findToken(opt("to", "base")!, symbol);
  const amount = BigInt(Math.round(Number(opt("amount", "5")) * 10 ** from.decimals)).toString();
  const q = await quote({
    dry: true,
    originAsset: from.assetId,
    destinationAsset: to.assetId,
    amount,
    // 1Click rejects burn addresses; default to vega.keel.testnet's Base address. A dry quote sends nothing.
    recipient: opt("recipient", "0x69aa0eb2153c0fed2cd3b44f418f50a02a3cffed")!,
    refundTo: opt("refund", "keel.near")!,
    deadline: deadlineFromNow(Number(opt("minutes", "30"))),
  });
  console.log(`Dry quote, nothing sent: ${q.amountInFormatted} ${symbol} on ${from.blockchain} -> ${q.amountOutFormatted} ${symbol} on ${to.blockchain}`);
  console.log(`Minimum out ${q.minAmountOut}, about ${q.timeEstimate ?? "?"} s after the deposit confirms`);
} else if (cmd === "status") {
  console.log(await status(rest[0]));
} else {
  console.log("Usage: npm run intents -- tokens [SYMBOL] | quote --to base --amount 5 | status <depositAddress>");
}
