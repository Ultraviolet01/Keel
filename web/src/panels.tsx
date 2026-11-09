import { useEffect, useMemo, useState } from "react";
import {
  accountExists,
  EXPLORER_TX,
  FACTORY_ID,
  formatNear,
  formatToken,
  parseToken,
  rememberCompanyName,
  roundUpNear,
  validVaultName,
  vaultNameFrom,
  type FactoryConfig,
  type Policy,
  type TokenMetadata,
} from "./near";
import { Copy, LoadLine, Shield, Wallet, X } from "./icons";
import { BILL_CHAINS, BURROW, CATEGORIES, PAYEE_KINDS, billId, isEvmAddress, type VaultPayee } from "./bills";

/** Sends one function call from the signed-in wallet; resolves to the outcome. */
export type Send = (
  receiverId: string,
  methodName: string,
  args: object,
  opts?: { deposit?: string; gas?: string },
) => Promise<{ transaction: { hash: string }; status: unknown }>;

/** Signs several function calls to one contract in a single transaction. */
export type SendBatch = (
  receiverId: string,
  calls: { methodName: string; args: object; gas: string; deposit: string }[],
) => Promise<{ transaction: { hash: string }; status: unknown }>;

export function Overlay({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  useEffect(() => {
    if (!onClose) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      {children}
    </div>
  );
}

function CloseButton({ onClose }: { onClose?: () => void }) {
  if (!onClose) return null;
  return (
    <button className="close" onClick={onClose} aria-label="Close">
      <X />
    </button>
  );
}

function friendly(e: unknown): string {
  const msg = String(e);
  if (/reject|cancel|denied/i.test(msg)) return "You cancelled the transaction in your wallet.";
  const refused = msg.match(/Keel Vault refused: [^"\\]+/);
  return refused ? refused[0] : msg;
}

// ------------------------------------------------------------------ connect

/** Read-only view of an account that is not valid or owns no Keel companies. */
export function ViewNotice({ accountId, invalid }: { accountId: string; invalid: boolean }) {
  return (
    <Overlay>
      <section className="card panel center" role="dialog" aria-labelledby="view-title">
        <span className="wordmark">KEEL</span>
        <h1 className="serif" id="view-title">
          {invalid ? "That is not a NEAR account name" : "No Keel companies here yet"}
        </h1>
        <p className="lead wrap-any">
          {invalid ? (
            <>The link asks to view <span className="mono">{accountId.slice(0, 80)}{accountId.length > 80 ? "…" : ""}</span>, which is not a valid NEAR account name.</>
          ) : (
            <><span className="mono">{accountId}</span> owns no Keel vaults on testnet.</>
          )}
        </p>
        <a className="btn primary lg block" href="/app">
          Open the app with your own wallet
        </a>
      </section>
    </Overlay>
  );
}

export function ConnectPanel({ onConnect, error }: { onConnect: () => void; error: string | null }) {
  return (
    <Overlay>
      <section className="card panel center" role="dialog" aria-labelledby="connect-title">
        <span className="wordmark">KEEL</span>
        <h1 className="serif" id="connect-title">
          Connect your wallet to open your treasury
        </h1>
        <p className="lead">Your wallet owns your companies' vaults. Keel never holds your key.</p>
        <button className="btn primary lg block" onClick={onConnect}>
          <Wallet />
          Connect wallet
        </button>
        <a className="link new" href="https://meteorwallet.app" target="_blank" rel="noreferrer">
          New to NEAR? Get a wallet
        </a>
        {error && <p className="error">{error}</p>}
        <div className="promises">
          <div>
            <LoadLine />
            Nothing moves alone until you set the line
          </div>
          <div>
            <Shield />
            The chain refuses anything past it
          </div>
        </div>
      </section>
    </Overlay>
  );
}

// ------------------------------------------------------------ create company

type NameState = "empty" | "invalid" | "checking" | "taken" | "free";

export function CreatePanel(props: {
  accountId: string;
  config: FactoryConfig;
  first: boolean;
  readOnly: boolean;
  send: Send;
  onClose?: () => void;
  onCreated: (vaultId: string) => Promise<void>;
}) {
  const [company, setCompany] = useState("");
  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const [state, setState] = useState<NameState>("empty");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const deposit = useMemo(() => roundUpNear(props.config.min_vault_deposit), [props.config]);
  const vaultId = `${name}.${FACTORY_ID}`;

  useEffect(() => {
    if (!edited) setName(vaultNameFrom(company));
  }, [company, edited]);

  // Names are first come, first served. When one is taken, offer free ones to click.
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    setSuggestions([]);
    if (!name) return setState("empty");
    if (!validVaultName(name)) return setState("invalid");
    setState("checking");
    let stale = false;
    const t = setTimeout(async () => {
      const taken = await accountExists(`${name}.${FACTORY_ID}`).catch(() => false);
      if (stale) return;
      setState(taken ? "taken" : "free");
      if (!taken) return;
      const base = name.slice(0, 28).replace(/[-_]+$/, "");
      const options = [`${base}-hq`, `${base}-co`, `${base}2`, `${base}-team`].filter(validVaultName);
      const free = await Promise.all(options.map(async (o) => ((await accountExists(`${o}.${FACTORY_ID}`).catch(() => true)) ? null : o)));
      if (!stale) setSuggestions(free.filter((o): o is string => Boolean(o)).slice(0, 3));
    }, 350);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [name]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await props.send(FACTORY_ID, "create_vault", { name }, { deposit: deposit.toString(), gas: "300000000000000" });
      setTx(outcome.transaction.hash);
      const status = outcome.status as { SuccessValue?: string };
      const created: string | null = status.SuccessValue ? JSON.parse(atob(status.SuccessValue)) : null;
      if (!created) {
        setError("The vault could not be created and your deposit was sent back. Try another address.");
        return;
      }
      rememberCompanyName(created, company.trim());
      await props.onCreated(created);
    } catch (e) {
      // Someone may have taken the name between the check and the click.
      if (/name is taken/i.test(String(e))) {
        setState("taken");
        setError(`Someone chose ${vaultId} a moment ago. Your deposit was not spent; choose another name.`);
      } else {
        setError(friendly(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const hint: Record<NameState, string> = {
    empty: "Lowercase letters, digits, - or _",
    invalid: "2 to 32 lowercase letters, digits, - or _, starting and ending with a letter or digit",
    checking: "Checking",
    taken: `${vaultId} has already been chosen by someone else. Choose another name.`,
    free: `${vaultId} is available`,
  };

  return (
    <Overlay onClose={props.onClose}>
      <section className="card panel form" role="dialog" aria-labelledby="create-title">
        <div className="panel-top">
          <span className="wordmark small">KEEL</span>
          <span className="muted small">
            Signed in as <span className="mono ink">{props.accountId}</span>
          </span>
          <CloseButton onClose={props.onClose} />
        </div>
        <h1 className="serif" id="create-title">
          {props.first ? "Name your first company" : "Add a company"}
        </h1>
        <p className="lead">
          Keel creates a vault for it that your wallet owns. It starts with no limits, so nothing moves alone until you
          set them.
        </p>

        <label className="field">
          <span className="label">Company name</span>
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company name" autoFocus />
        </label>
        <label className="field">
          <span className="label">Vault address</span>
          <span className="input-group">
            <input
              className="mono-input"
              value={name}
              onChange={(e) => {
                setEdited(true);
                setName(e.target.value.toLowerCase());
              }}
              placeholder="name"
            />
            <span className="suffix">.{FACTORY_ID}</span>
          </span>
          <span className={`hint ${state}`}>{hint[state]}</span>
          {state === "taken" && suggestions.length > 0 && (
            <span className="name-suggest">
              <span className="muted small">Free:</span>
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setEdited(true);
                    setName(s);
                  }}
                >
                  {s}
                </button>
              ))}
            </span>
          )}
        </label>

        <div className="facts">
          <div>
            <span>Keel's agent</span>
            <span>Pays inside your limits, proposes everything else</span>
          </div>
          <div>
            <span>Limits</span>
            <span className="brass">None yet · you set them next</span>
          </div>
          <div>
            <span>Deposit</span>
            <span>
              <b className="num">{formatNear(deposit)} NEAR</b> <span className="muted">stays in the vault for storage and gas</span>
            </span>
          </div>
        </div>

        {error && <p className="error">{error}</p>}
        {tx && (
          <p className="muted small">
            Transaction{" "}
            <a className="mono" href={EXPLORER_TX + tx} target="_blank" rel="noreferrer">
              {tx.slice(0, 10)}…
            </a>
          </p>
        )}
        <button
          className="btn primary lg block"
          onClick={create}
          disabled={props.readOnly || busy || state !== "free" || !company.trim()}
        >
          {busy ? "Approve in your wallet" : "Create vault"}
        </button>
        <p className="muted tiny centered">Your wallet asks you to approve one transaction</p>
      </section>
    </Overlay>
  );
}

// -------------------------------------------------------------- set limits

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function lines(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export function LimitsPanel(props: {
  vaultId: string;
  policy: Policy;
  token: TokenMetadata;
  send: Send;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { policy, token } = props;
  const show = (raw: string) => (raw === "0" ? "" : formatToken(raw, token.decimals).replace(/\.00$/, ""));
  const [perPayment, setPerPayment] = useState(show(policy.per_payment_cap));
  const [perDay, setPerDay] = useState(show(policy.daily_cap));
  // Older vaults ignore min_balance, so the field only shows where the vault enforces it.
  const hasBuffer = policy.min_balance !== undefined;
  const [buffer, setBuffer] = useState(show(policy.min_balance ?? "0"));
  const [payees, setPayees] = useState(policy.allowlist.join("\n"));
  const [blocked, setBlocked] = useState(policy.blocklist.join("\n"));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const per = parseToken(perPayment || "0", token.decimals);
  const day = parseToken(perDay || "0", token.decimals);
  const floor = parseToken(buffer || "0", token.decimals);
  const allow = lines(payees);
  const block = lines(blocked);
  const badAccount = [...allow, ...block].find((a) => !ACCOUNT.test(a) || a.length < 2 || a.length > 64);
  const both = allow.find((a) => block.includes(a));
  const problem =
    per === null || day === null || floor === null
      ? `Enter amounts in ${token.symbol}, for example 100 or 100.50`
      : BigInt(per) > BigInt(day)
        ? "The per-payment cap cannot be more than the daily cap"
        : badAccount
          ? `${badAccount} is not a NEAR account id`
          : both
            ? `${both} cannot be both allowed and blocked`
            : null;

  const save = async () => {
    if (problem || per === null || day === null || floor === null) return;
    setBusy(true);
    setError(null);
    const update = {
      per_payment_cap: per,
      daily_cap: day,
      ...(hasBuffer ? { min_balance: floor } : {}),
      allow: allow.filter((a) => !policy.allowlist.includes(a)),
      disallow: policy.allowlist.filter((a) => !allow.includes(a)),
      block: block.filter((a) => !policy.blocklist.includes(a)),
      unblock: policy.blocklist.filter((a) => !block.includes(a)),
    };
    try {
      await props.send(props.vaultId, "update_policy", { update, reason: reason.trim() || "Set in the Keel app" }, { deposit: "1" });
      await props.onSaved();
      props.onClose();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={props.onClose}>
      <section className="card panel form" role="dialog" aria-labelledby="limits-title">
        <div className="panel-top">
          <span className="panel-icon brass">
            <LoadLine />
          </span>
          <CloseButton onClose={props.onClose} />
        </div>
        <h1 className="serif" id="limits-title">
          Set your limits
        </h1>
        <p className="lead">Keel pays alone only to these payees and only up to these amounts. Anything else waits for you.</p>

        <div className="two">
          <label className="field">
            <span className="label">Per payment</span>
            <span className="input-group">
              <input className="num" inputMode="decimal" value={perPayment} onChange={(e) => setPerPayment(e.target.value)} placeholder="0.00" />
              <span className="suffix">{token.symbol}</span>
            </span>
          </label>
          <label className="field">
            <span className="label">Per day</span>
            <span className="input-group">
              <input className="num" inputMode="decimal" value={perDay} onChange={(e) => setPerDay(e.target.value)} placeholder="0.00" />
              <span className="suffix">{token.symbol}</span>
            </span>
          </label>
        </div>
        {hasBuffer && (
          <label className="field">
            <span className="label">Cash buffer</span>
            <span className="input-group">
              <input className="num" inputMode="decimal" value={buffer} onChange={(e) => setBuffer(e.target.value)} placeholder="0.00" />
              <span className="suffix">{token.symbol}</span>
            </span>
            <span className="hint">Keel never pays if the vault would hold less than this. Bills not marked critical wait until they are due, then come to you.</span>
          </label>
        )}
        <label className="field">
          <span className="label">Payees Keel may pay alone</span>
          <textarea className="mono-input" rows={3} value={payees} onChange={(e) => setPayees(e.target.value)} placeholder={"One NEAR account per line"} />
          <span className="hint">One NEAR account per line</span>
        </label>
        <label className="field">
          <span className="label">Blocked addresses</span>
          <textarea className="mono-input" rows={2} value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder="Never pay these" />
        </label>
        <label className="field">
          <span className="label">Reason for the ledger</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why you are changing them" />
        </label>

        {(problem || error) && <p className="error">{problem ?? error}</p>}
        <button className="btn primary lg block" onClick={save} disabled={busy || Boolean(problem)}>
          {busy ? "Approve in your wallet" : "Save limits"}
        </button>
        <p className="muted tiny centered">Signed with your wallet and enforced by the vault contract</p>
      </section>
    </Overlay>
  );
}

// ----------------------------------------------------------------- deposit

export function DepositPanel(props: { vaultId: string; token: TokenMetadata; tokenId: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.vaultId);
      setCopied(true);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <Overlay onClose={props.onClose}>
      <section className="card panel form" role="dialog" aria-labelledby="deposit-title">
        <div className="panel-top">
          <span className="panel-icon">
            <Wallet />
          </span>
          <CloseButton onClose={props.onClose} />
        </div>
        <h1 className="serif" id="deposit-title">
          Deposit {props.token.symbol}
        </h1>
        <p className="lead">
          Send {props.token.symbol} on NEAR to your vault's address. It is already registered with the token, so the transfer
          lands directly.
        </p>
        <div className="addr">
          <span className="mono ink">{props.vaultId}</span>
          <button className="btn sm" onClick={copy}>
            <Copy size={14} />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="facts">
          <div>
            <span>Token contract</span>
            <span className="mono ink">{props.tokenId}</span>
          </div>
          <div>
            <span>Other chains</span>
            <span>Come in through NEAR Intents once your limits are set</span>
          </div>
        </div>
      </section>
    </Overlay>
  );
}

// ------------------------------------------------------------- new payment

export function PayPanel(props: { vaultId: string; token: TokenMetadata; balance: string; send: Send; onClose: () => void; onPaid: () => Promise<void> }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const raw = parseToken(amount || "0", props.token.decimals);
  const problem = !to
    ? "Enter who to pay"
    : !ACCOUNT.test(to.trim().toLowerCase())
      ? `${to} is not a NEAR account id`
      : raw === null || raw === "0"
        ? `Enter an amount in ${props.token.symbol}`
        : BigInt(raw) > BigInt(props.balance)
          ? `The vault holds ${formatToken(props.balance, props.token.decimals)} ${props.token.symbol}`
          : null;

  const pay = async () => {
    if (problem || !raw) return;
    setBusy(true);
    setError(null);
    try {
      await props.send(props.vaultId, "withdraw", { receiver_id: to.trim().toLowerCase(), amount: raw, memo: memo.trim() || null }, { deposit: "1", gas: "100000000000000" });
      await props.onPaid();
      props.onClose();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={props.onClose}>
      <section className="card panel form" role="dialog" aria-labelledby="pay-title">
        <div className="panel-top">
          <span className="panel-icon">
            <Wallet />
          </span>
          <CloseButton onClose={props.onClose} />
        </div>
        <h1 className="serif" id="pay-title">New payment</h1>
        <p className="lead">Paid from the vault straight away with your signature. Your limits bind Keel's agent, not you.</p>
        <label className="field">
          <span className="label">Pay to</span>
          <input className="mono-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="account.testnet" autoFocus />
        </label>
        <label className="field">
          <span className="label">Amount</span>
          <span className="input-group">
            <input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            <span className="suffix">{props.token.symbol}</span>
          </span>
          <span className="hint">Vault holds {formatToken(props.balance, props.token.decimals)} {props.token.symbol}</span>
        </label>
        <label className="field">
          <span className="label">Memo</span>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Invoice number or note" />
        </label>
        {(error || (to && amount && problem)) && <p className="error">{error ?? problem}</p>}
        <button className="btn primary lg block" onClick={pay} disabled={busy || Boolean(problem)}>
          {busy ? "Approve in your wallet" : "Pay from the vault"}
        </button>
      </section>
    </Overlay>
  );
}

type InvoiceDraft = {
  vendor?: string | null;
  amount?: string | null;
  currency?: string | null;
  due?: string | null;
  invoice_number?: string | null;
  payment_address?: string | null;
  chain?: string | null;
  category?: string | null;
  repeats?: "once" | "monthly" | "yearly" | null;
};

/** Sends an invoice to /api/read-invoice (a Vercel function that asks Claude). */
async function readInvoice(file: File): Promise<InvoiceDraft> {
  if (file.size > 3_000_000) throw new Error("That file is over 3 MB. Use a smaller PDF or photo.");
  const data = await new Promise<string>((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => bad(r.error);
    r.readAsDataURL(file);
  });
  const res = await fetch("/api/read-invoice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, media_type: file.type }) });
  if (res.status === 404) throw new Error("Invoice reading runs on the hosted app only. Fill in the bill by hand here.");
  const body = (await res.json().catch(() => ({}))) as { draft?: InvoiceDraft; error?: string };
  if (!res.ok || !body.draft) throw new Error(body.error ?? `Could not read the invoice (${res.status}).`);
  return body.draft;
}

export function BillPanel(props: { vaultId: string; token: TokenMetadata; policy: Policy; payees: VaultPayee[] | null; send: Send; onClose: () => void; onSaved: () => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [chain, setChain] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState(() => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  const [repeat, setRepeat] = useState<"once" | "monthly" | "yearly">("once");
  const [category, setCategory] = useState("other");
  const [memo, setMemo] = useState("");
  const [critical, setCritical] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [fromInvoice, setFromInvoice] = useState<InvoiceDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const payee = to.trim().toLowerCase();
  const raw = parseToken(amount || "0", props.token.decimals);
  const named = (props.payees ?? []).find((x) => x.account_id === payee);
  const approved = !chain && props.policy.allowlist.includes(payee);
  const blocked = props.policy.blocklist.includes(payee);
  const problem = !label.trim()
    ? "Name the bill, for example Domain renewal"
    : !payee
      ? "Pick a payee or enter who to pay"
      : chain && !isEvmAddress(payee)
        ? `Enter the payee's 0x address on ${BILL_CHAINS[chain]}`
        : !chain && !ACCOUNT.test(payee)
          ? `${to} is not a NEAR account id`
          : raw === null || raw === "0"
            ? `Enter an amount in ${props.token.symbol}`
            : !/^\d{4}-\d{2}-\d{2}$/.test(due)
              ? "Pick a due date"
              : null;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setError(null);
    try {
      const d = await readInvoice(file);
      setFromInvoice(d);
      if (d.vendor) setLabel([d.vendor, d.invoice_number && `invoice ${d.invoice_number}`].filter(Boolean).join(", ").slice(0, 80));
      if (d.amount) setAmount(d.amount);
      if (d.due && /^\d{4}-\d{2}-\d{2}$/.test(d.due)) setDue(d.due);
      if (d.category && CATEGORIES[d.category]) setCategory(d.category);
      if (d.repeats) setRepeat(d.repeats);
      if (d.invoice_number) setMemo(`Invoice ${d.invoice_number}`.slice(0, 140));
      // A payee you already named wins over anything the invoice says.
      const match = (props.payees ?? []).find((x) => d.vendor && x.name.toLowerCase().includes(d.vendor.toLowerCase().split(" ")[0]));
      if (match) {
        setChain("");
        setTo(match.account_id);
      } else if (d.payment_address) {
        const addr = d.payment_address.trim().toLowerCase();
        if (isEvmAddress(addr)) {
          setChain(d.chain && BILL_CHAINS[d.chain] ? d.chain : "base");
          setTo(addr);
        } else if (ACCOUNT.test(addr)) {
          setChain("");
          setTo(addr);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  };

  const save = async () => {
    if (problem || !raw) return;
    setBusy(true);
    setError(null);
    try {
      const bill = {
        id: billId(label),
        payee,
        amount: raw,
        due,
        monthly: repeat === "monthly",
        yearly: repeat === "yearly",
        category,
        ...(props.policy.min_balance !== undefined ? { critical } : {}),
        chain: chain || null,
        label: label.trim(),
        memo: memo.trim() || null,
      };
      await props.send(props.vaultId, "add_bill", { bill }, { deposit: "1", gas: "30000000000000" });
      await props.onSaved();
      props.onClose();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  // How Keel will treat this bill, said before the owner signs.
  const outcome = blocked
    ? { cls: "invalid", text: "This account is on your blocklist. Keel will refuse to pay it." }
    : chain
      ? { cls: "", text: "Paid from the vault's own address on that chain. Keel proposes it to you each time; nothing moves without your approval." }
      : approved
        ? { cls: "free", text: `${named ? named.name : "An approved payee"}. Keel pays it on its own when it is due, if it is within your caps.` }
        : payee
          ? { cls: "taken", text: "Not one of your approved payees. Keel will propose it to you each time. Add it on the Payees page to let Keel pay it on its own." }
          : null;

  return (
    <Overlay onClose={props.onClose}>
      <section className="card panel form" role="dialog" aria-labelledby="bill-title">
        <div className="panel-top">
          <span className="panel-icon">
            <Wallet />
          </span>
          <CloseButton onClose={props.onClose} />
        </div>
        <h1 className="serif" id="bill-title">Add a bill</h1>
        <p className="lead">Keel pays it when it is due, inside your limits. Saved on the vault with your signature.</p>
        <label className="field">
          <span className="label">Start from an invoice (optional)</span>
          <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" disabled={reading} onChange={(e) => onFile(e.target.files?.[0])} />
          <span className="hint">{reading ? "Claude is reading the invoice…" : "PDF or photo, up to 3 MB. Claude fills in the fields; you check them before signing."}</span>
        </label>
        {fromInvoice && (
          <p className="hint">
            Filled in from the invoice. Check every field.
            {fromInvoice.currency && fromInvoice.currency.toUpperCase() !== props.token.symbol.toUpperCase() && ` The invoice is in ${fromInvoice.currency}; the vault pays ${props.token.symbol}.`}
            {fromInvoice.payment_address && !approved && " The payment address came from the invoice and is not one of your payees: invoices can be forged, so confirm it with the vendor."}
          </p>
        )}
        <label className="field">
          <span className="label">What is it</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What the bill is for" maxLength={80} />
        </label>
        <div className="two">
          <label className="field">
            <span className="label">Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(CATEGORIES).map(([k, name]) => (
                <option key={k} value={k}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Repeats</span>
            <select value={repeat} onChange={(e) => setRepeat(e.target.value as "once" | "monthly" | "yearly")}>
              <option value="once">Once</option>
              <option value="monthly">Every month</option>
              <option value="yearly">Every year</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span className="label">Paid on</span>
          <select value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="">NEAR</option>
            {Object.entries(BILL_CHAINS).map(([k, name]) => (
              <option key={k} value={k}>
                {name}, from the vault's own address
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Pay to</span>
          {!chain && props.payees && props.payees.length > 0 && (
            <select value={named ? payee : ""} onChange={(e) => e.target.value && setTo(e.target.value)}>
              <option value="">Pick an approved payee…</option>
              {props.payees.map((x) => (
                <option key={x.account_id} value={x.account_id}>
                  {x.name} ({x.account_id})
                </option>
              ))}
            </select>
          )}
          <input className="mono-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder={chain ? "0x…" : "or type a NEAR account"} />
          {outcome && <span className={`hint ${outcome.cls}`}>{outcome.text}</span>}
        </label>
        <div className="two">
          <label className="field">
            <span className="label">Amount</span>
            <span className="input-group">
              <input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              <span className="suffix">{props.token.symbol}</span>
            </span>
          </label>
          <label className="field">
            <span className="label">{repeat === "once" ? "Due date" : "First due date"}</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span className="label">Note (optional)</span>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Invoice number or note" maxLength={140} />
        </label>
        {props.policy.min_balance !== undefined && (
          <label className="check">
            <input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} /> Critical: pay this first, even when cash is tight
          </label>
        )}
        {(error || (label && to && amount && problem)) && <p className="error">{error ?? problem}</p>}
        <button className="btn primary lg block" onClick={save} disabled={busy || reading || Boolean(problem)}>
          {busy ? "Approve in your wallet" : "Add bill"}
        </button>
      </section>
    </Overlay>
  );
}

export function PayeePanel(props: {
  vaultId: string;
  token: TokenMetadata;
  policy: Policy;
  agentMethods?: string[];
  send: Send;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [account, setAccount] = useState("");
  const [kind, setKind] = useState("vendor");
  const [keepAt, setKeepAt] = useState("");
  const [maxMove, setMaxMove] = useState("");
  const [lending, setLending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = account.trim().toLowerCase();
  const tops = kind === "card" || kind === "own";
  const keepRaw = keepAt ? parseToken(keepAt, props.token.decimals) : null;
  const isYield = kind === "yield";
  const maxRaw = maxMove ? parseToken(maxMove, props.token.decimals) : null;
  // Older vaults have no yield kind or cash buffer; the option only appears where the vault enforces it.
  const yieldReady = props.policy.min_balance !== undefined;
  // Lending markets need the vault code with recall_from_yield; the agent key lists it there.
  const lendingReady = (props.agentMethods ?? []).includes("recall_from_yield");
  const problem = !name.trim()
    ? "Name the payee, for example Company card"
    : !ACCOUNT.test(id)
      ? "Enter the payee's NEAR account"
      : props.policy.blocklist.includes(id)
        ? "That account is on your blocklist; unblock it on the Rules page first"
        : keepAt && (keepRaw === null || keepRaw === "0")
          ? `Enter the balance to keep in ${props.token.symbol}`
          : isYield && (maxRaw === null || maxRaw === "0")
            ? `Enter the most Keel may move at once, in ${props.token.symbol}`
            : isYield && props.policy.min_balance === "0"
              ? "Set a cash buffer in Set limits first: Keel moves only cash above it"
              : null;

  const save = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const payee = {
        account_id: id,
        name: name.trim(),
        kind,
        keep_at: tops && keepRaw ? keepRaw : null,
        ...(yieldReady ? { max_move: isYield ? maxRaw : null } : {}),
        ...(lendingReady ? { lending: isYield && lending } : {}),
      };
      await props.send(props.vaultId, "add_payee", { payee }, { deposit: "1", gas: "30000000000000" });
      await props.onSaved();
      props.onClose();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={props.onClose}>
      <section className="card panel form" role="dialog" aria-labelledby="payee-title">
        <div className="panel-top">
          <span className="panel-icon">
            <Shield />
          </span>
          <CloseButton onClose={props.onClose} />
        </div>
        <h1 className="serif" id="payee-title">Approve a payee</h1>
        <p className="lead">
          Keel may pay an approved payee on its own, within your caps. Get the account from the vendor, card provider or off-ramp directly, never from an email or invoice alone.
        </p>
        <label className="field">
          <span className="label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={80} autoFocus />
        </label>
        <label className="field">
          <span className="label">Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(PAYEE_KINDS)
              .filter(([k]) => k !== "yield" || yieldReady)
              .map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          {PAYEE_KINDS[kind].note && <span className="hint">{PAYEE_KINDS[kind].note}</span>}
        </label>
        <label className="field">
          <span className="label">NEAR account</span>
          <input className="mono-input" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="account.testnet" />
        </label>
        {isYield && lendingReady && (
          <label className="check">
            <input
              type="checkbox"
              checked={lending}
              onChange={(e) => {
                setLending(e.target.checked);
                if (e.target.checked) {
                  setAccount(FACTORY_ID.endsWith(".near") ? BURROW.mainnet : BURROW.testnet);
                  if (!name) setName("Burrow lending");
                }
              }}
            />{" "}
            It's a lending market (Burrow): deposits earn interest in the vault's own account there
          </label>
        )}
        {isYield && (
          <label className="field">
            <span className="label">Most Keel may move at once</span>
            <span className="input-group">
              <input className="num" inputMode="decimal" value={maxMove} onChange={(e) => setMaxMove(e.target.value)} placeholder="0.00" />
              <span className="suffix">{props.token.symbol}</span>
            </span>
            <span className="hint">The vault refuses any larger move. Bringing money back is up to you, from that account.</span>
          </label>
        )}
        {tops && (
          <label className="field">
            <span className="label">Keep this much in it (optional)</span>
            <span className="input-group">
              <input className="num" inputMode="decimal" value={keepAt} onChange={(e) => setKeepAt(e.target.value)} placeholder="0.00" />
              <span className="suffix">{props.token.symbol}</span>
            </span>
            <span className="hint">Keel tops it back up to this when it holds less, at most once a day and within your caps.</span>
          </label>
        )}
        {(error || (name && account && problem)) && <p className="error">{error ?? problem}</p>}
        <button className="btn primary lg block" onClick={save} disabled={busy || Boolean(problem)}>
          {busy ? "Approve in your wallet" : "Approve payee"}
        </button>
      </section>
    </Overlay>
  );
}

// ------------------------------------------------------------- import invoices

type ImportRow = {
  key: string;
  file: string;
  state: "reading" | "ready" | "failed";
  error?: string;
  label: string;
  chain: string;
  to: string;
  amount: string;
  due: string;
  category: string;
  repeat: "once" | "monthly" | "yearly";
  critical: boolean;
  memo: string;
  fromInvoiceAddress: boolean;
  currency: string | null;
};

const MAX_IMPORT = 10;

/** Up to 10 invoices at once: Claude drafts each, the owner checks the rows and signs them all in one transaction. */
export function ImportPanel(props: {
  vaultId: string;
  token: TokenMetadata;
  policy: Policy;
  payees: VaultPayee[] | null;
  sendBatch: SendBatch;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reading = rows.some((r) => r.state === "reading");
  const hasBuffer = props.policy.min_balance !== undefined;
  const set = (key: string, patch: Partial<ImportRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const onFiles = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setError(null);
    const files = [...list].slice(0, MAX_IMPORT - rows.length);
    if (list.length > files.length) setError(`At most ${MAX_IMPORT} invoices at once; the first ${files.length} were added.`);
    const fresh: ImportRow[] = files.map((f, i) => ({
      key: `${Date.now()}-${i}-${f.name}`,
      file: f.name,
      state: "reading",
      label: "",
      chain: "",
      to: "",
      amount: "",
      due: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      category: "other",
      repeat: "once",
      critical: false,
      memo: "",
      fromInvoiceAddress: false,
      currency: null,
    }));
    setRows((rs) => [...rs, ...fresh]);
    // One at a time: each file is one call to Claude, and the server allows a few per minute.
    for (let i = 0; i < files.length; i++) {
      const row = fresh[i];
      try {
        const d = await readInvoice(files[i]);
        const patch: Partial<ImportRow> = { state: "ready", currency: d.currency ?? null };
        if (d.vendor) patch.label = [d.vendor, d.invoice_number && `invoice ${d.invoice_number}`].filter(Boolean).join(", ").slice(0, 80);
        if (d.amount) patch.amount = d.amount;
        if (d.due && /^\d{4}-\d{2}-\d{2}$/.test(d.due)) patch.due = d.due;
        if (d.category && CATEGORIES[d.category]) patch.category = d.category;
        if (d.repeats) patch.repeat = d.repeats;
        if (d.invoice_number) patch.memo = `Invoice ${d.invoice_number}`.slice(0, 140);
        // A payee you already named wins over anything the invoice says.
        const match = (props.payees ?? []).find((x) => d.vendor && x.name.toLowerCase().includes(d.vendor.toLowerCase().split(" ")[0]));
        if (match) {
          patch.chain = "";
          patch.to = match.account_id;
        } else if (d.payment_address) {
          const addr = d.payment_address.trim().toLowerCase();
          if (isEvmAddress(addr)) {
            patch.chain = d.chain && BILL_CHAINS[d.chain] ? d.chain : "base";
            patch.to = addr;
            patch.fromInvoiceAddress = true;
          } else if (ACCOUNT.test(addr)) {
            patch.to = addr;
            patch.fromInvoiceAddress = true;
          }
        }
        set(row.key, patch);
      } catch (e) {
        set(row.key, { state: "failed", error: e instanceof Error ? e.message : String(e) });
      }
    }
  };

  const problemOf = (r: ImportRow): string | null => {
    if (r.state === "reading") return "Reading…";
    const payee = r.to.trim().toLowerCase();
    const raw = parseToken(r.amount || "0", props.token.decimals);
    if (!r.label.trim()) return "Name the bill";
    if (!payee) return "Enter who to pay";
    if (r.chain && !isEvmAddress(payee)) return `Enter a 0x address on ${BILL_CHAINS[r.chain]}`;
    if (!r.chain && !ACCOUNT.test(payee)) return "Not a NEAR account id";
    if (raw === null || raw === "0") return `Enter an amount in ${props.token.symbol}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.due)) return "Pick a due date";
    return null;
  };
  const statusOf = (r: ImportRow): { cls: string; text: string } | null => {
    const payee = r.to.trim().toLowerCase();
    if (!payee) return null;
    if (props.policy.blocklist.includes(payee)) return { cls: "invalid", text: "On your blocklist: Keel will refuse it" };
    if (r.chain) return { cls: "", text: `Paid on ${BILL_CHAINS[r.chain]}: Keel asks you each time` };
    const named = (props.payees ?? []).find((x) => x.account_id === payee);
    if (props.policy.allowlist.includes(payee)) return { cls: "free", text: `${named ? named.name : "Approved payee"}: Keel pays it within your caps` };
    return { cls: "taken", text: r.fromInvoiceAddress ? "New account from the invoice: confirm it with the vendor. Keel will ask you" : "Not an approved payee: Keel will ask you" };
  };

  const ready = rows.filter((r) => r.state !== "failed");
  const allOk = ready.length > 0 && ready.every((r) => !problemOf(r));

  const save = async () => {
    if (!allOk) return;
    setBusy(true);
    setError(null);
    try {
      const calls = ready.map((r) => ({
        methodName: "add_bill",
        args: {
          bill: {
            id: billId(r.label),
            payee: r.to.trim().toLowerCase(),
            amount: parseToken(r.amount, props.token.decimals)!,
            due: r.due,
            monthly: r.repeat === "monthly",
            yearly: r.repeat === "yearly",
            category: r.category,
            ...(hasBuffer ? { critical: r.critical } : {}),
            chain: r.chain || null,
            label: r.label.trim(),
            memo: r.memo.trim() || null,
          },
        },
        gas: "25000000000000",
        deposit: "1",
      }));
      await props.sendBatch(props.vaultId, calls);
      await props.onSaved();
      props.onClose();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={props.onClose}>
      <section className="card panel form wide" role="dialog" aria-labelledby="import-title">
        <div className="panel-top">
          <span className="panel-icon">
            <Wallet />
          </span>
          <CloseButton onClose={props.onClose} />
        </div>
        <h1 className="serif" id="import-title">Import invoices</h1>
        <p className="lead">
          Add up to {MAX_IMPORT} PDFs or photos. Claude reads each into a draft bill; you check every row, then sign them all at once. Files are not stored.
        </p>
        <label className={`drop ${reading ? "busy" : ""}`}>
          <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp" disabled={reading || rows.length >= MAX_IMPORT} onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
          <b>{reading ? "Claude is reading your invoices…" : rows.length ? "Add more invoices" : "Choose invoices"}</b>
          <span className="muted small">PDF or photo, up to 3 MB each</span>
        </label>

        {rows.length > 0 && (
          <ul className="imp-rows">
            {rows.map((r) => {
              const st = statusOf(r);
              const prob = problemOf(r);
              return (
                <li key={r.key} className={`imp-row ${r.state}`}>
                  <div className="imp-top">
                    <span className="mono small">{r.file}</span>
                    {r.state === "reading" && <span className="pill warn">Reading</span>}
                    {r.state === "failed" && <span className="pill bad">Could not read</span>}
                    <button className="link-btn" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                      Remove
                    </button>
                  </div>
                  {r.state === "failed" ? (
                    <p className="hint invalid">{r.error} Add this one with Add bill instead.</p>
                  ) : (
                    <>
                      <div className="imp-grid">
                        <input value={r.label} onChange={(e) => set(r.key, { label: e.target.value })} placeholder="What the bill is for" maxLength={80} disabled={r.state === "reading"} />
                        <span className="input-group">
                          <input className="num" inputMode="decimal" value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} placeholder="0.00" disabled={r.state === "reading"} />
                          <span className="suffix">{props.token.symbol}</span>
                        </span>
                        <input type="date" value={r.due} onChange={(e) => set(r.key, { due: e.target.value })} disabled={r.state === "reading"} />
                      </div>
                      <div className="imp-grid">
                        <select value={r.chain} onChange={(e) => set(r.key, { chain: e.target.value })} disabled={r.state === "reading"}>
                          <option value="">NEAR</option>
                          {Object.entries(BILL_CHAINS).map(([k, n]) => (
                            <option key={k} value={k}>
                              {n}
                            </option>
                          ))}
                        </select>
                        <input className="mono-input" value={r.to} onChange={(e) => set(r.key, { to: e.target.value, fromInvoiceAddress: false })} placeholder={r.chain ? "0x…" : "account.testnet"} disabled={r.state === "reading"} />
                        <select value={r.category} onChange={(e) => set(r.key, { category: e.target.value })} disabled={r.state === "reading"}>
                          {Object.entries(CATEGORIES).map(([k, n]) => (
                            <option key={k} value={k}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="imp-foot">
                        <select value={r.repeat} onChange={(e) => set(r.key, { repeat: e.target.value as ImportRow["repeat"] })} disabled={r.state === "reading"}>
                          <option value="once">Once</option>
                          <option value="monthly">Every month</option>
                          <option value="yearly">Every year</option>
                        </select>
                        {hasBuffer && (
                          <label className="check">
                            <input type="checkbox" checked={r.critical} onChange={(e) => set(r.key, { critical: e.target.checked })} /> Critical
                          </label>
                        )}
                        {r.state === "ready" && (prob ? <span className="hint invalid">{prob}</span> : st && <span className={`hint ${st.cls}`}>{st.text}</span>)}
                      </div>
                      {r.currency && r.currency.toUpperCase() !== props.token.symbol.toUpperCase() && r.state === "ready" && (
                        <p className="hint">The invoice is in {r.currency}; the vault pays {props.token.symbol}. Check the amount.</p>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {error && <p className="error">{error}</p>}
        <button className="btn primary lg block" onClick={save} disabled={busy || reading || !allOk}>
          {busy ? "Approve in your wallet" : ready.length ? `Add ${ready.length} ${ready.length === 1 ? "bill" : "bills"} with one signature` : "Add bills"}
        </button>
        <p className="muted tiny centered">Saved on the vault with your signature. Keel still pays each one only inside your limits.</p>
      </section>
    </Overlay>
  );
}
