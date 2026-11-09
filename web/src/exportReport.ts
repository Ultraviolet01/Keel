// Downloads the treasury report as an Excel workbook (.xlsx), built in the
// browser from the vault's live data. ExcelJS loads only when asked.

import { FACTORY_ID, companyName } from "./near";
import { evmWallet } from "./evm";
import { buildReport, type Range, type TxInfo } from "./report";
import type { VaultData } from "./vault";

const ARCHIVE = FACTORY_ID.endsWith(".near") ? "https://archival-rpc.mainnet.fastnear.com" : "https://archival-rpc.testnet.fastnear.com";
const EXPLORER = FACTORY_ID.endsWith(".near") ? "https://nearblocks.io/txns/" : "https://testnet.nearblocks.io/txns/";
const TEAL = "FF0B5C55";

async function fetchRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  for (let n = 1; ; n++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || n >= tries) return res;
    await new Promise((r) => setTimeout(r, 800 * n));
  }
}

/** Who signed each transaction and the first method it called, from the archive node. */
async function txInfos(vaultId: string, hashes: string[]): Promise<Record<string, TxInfo>> {
  const out: Record<string, TxInfo> = {};
  const unique = [...new Set(hashes)];
  // A few at a time, retrying when the archive says "too many requests".
  for (let i = 0; i < unique.length; i += 4) {
    await Promise.all(
      unique.slice(i, i + 4).map(async (hash) => {
        try {
          const res = await fetchRetry(ARCHIVE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: vaultId, wait_until: "NONE" } }),
            signal: AbortSignal.timeout(10_000),
          });
          const t = (await res.json()).result?.transaction as { signer_id: string; actions: ({ FunctionCall?: { method_name: string } } | string)[] } | undefined;
          if (!t) return;
          const call = t.actions.find((a) => typeof a === "object" && a.FunctionCall) as { FunctionCall: { method_name: string } } | undefined;
          out[hash] = { signer: t.signer_id, method: call?.FunctionCall.method_name ?? "" };
        } catch {
          /* unknown: the row falls back to the counterparty */
        }
      }),
    );
  }
  return out;
}

export async function downloadReport(vaultId: string, d: VaultData, range: Range = { from: null, to: null }): Promise<void> {
  const [{ default: ExcelJS }, txs, evm] = await Promise.all([
    import("exceljs"),
    txInfos(vaultId, (d.history ?? []).map((h) => h.hash).filter((h): h is string => !!h)),
    evmWallet(vaultId).catch(() => null),
  ]);
  const now = Date.now();
  const company = companyName(vaultId);
  const sheets = buildReport({
    vaultId,
    company,
    d,
    now,
    txs,
    evm: evm ? { address: evm.address, chains: evm.chains.map((c) => ({ name: c.chain.name, usdc: c.usdc, gas: c.gas, decimals: c.route.decimals ?? 6 })) } : null,
    explorerTx: EXPLORER,
    range,
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "Keel";
  wb.created = new Date(now);
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: "frozen", ySplit: s.name === "Summary" ? 0 : 1 }] });
    ws.columns = s.columns.map((c) => ({ header: s.name === "Summary" ? undefined : c.header, width: c.width }));
    if (s.name !== "Summary") {
      const head = ws.getRow(1);
      head.font = { bold: true, color: { argb: "FFFFFFFF" } };
      head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TEAL } };
      head.alignment = { vertical: "middle" };
      head.height = 20;
    }
    for (const row of s.rows) ws.addRow(row);
    s.columns.forEach((c, i) => {
      if (c.money) ws.getColumn(i + 1).numFmt = '#,##0.00;[Red]-#,##0.00';
    });
    if (s.name === "Summary") {
      ws.getCell("A1").font = { bold: true, size: 14, color: { argb: TEAL } };
      for (const label of ["Balances (now)", "Activity", "Rules"]) {
        const r = s.rows.findIndex((x) => x[0] === label) + 1;
        if (r > 0) {
          ws.getRow(r).font = { bold: true, color: { argb: "FFFFFFFF" } };
          ["A", "B"].forEach((col) => (ws.getCell(`${col}${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: TEAL } }));
        }
      }
      // Amounts get two decimals; counts stay whole numbers.
      s.rows.forEach((x, k) => {
        if (typeof x[1] === "number" && /\(|Total/.test(String(x[0]))) ws.getCell(`B${k + 1}`).numFmt = "#,##0.00;[Red]-#,##0.00";
      });
      ws.getColumn(2).alignment = { horizontal: "right" };
      const total = s.rows.findIndex((x) => x[0] === "Total treasury") + 1;
      if (total > 0) ws.getRow(total).font = { bold: true };
    }
    if (s.name === "Ledger") {
      const link = s.columns.findIndex((c) => c.header === "Link") + 1;
      ws.eachRow((row, n) => {
        const cell = row.getCell(link);
        if (n > 1 && typeof cell.value === "string" && cell.value) {
          cell.value = { text: "View", hyperlink: cell.value };
          cell.font = { color: { argb: "FF0563C1" }, underline: true };
        }
      });
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const span = range.from === null && range.to === null ? "all-time" : `${range.from === null ? "start" : new Date(range.from).toISOString().slice(0, 10)}-to-${range.to === null ? "present" : new Date(range.to).toISOString().slice(0, 10)}`;
  a.download = `keel-${vaultId.split(".")[0]}-${span}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
