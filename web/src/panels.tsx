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

/** Sends one function call from the signed-in wallet; resolves to the outcome. */
export type Send = (
  receiverId: string,
  methodName: string,
  args: object,
  opts?: { deposit?: string; gas?: string },
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
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Kora Supply Group" autoFocus />
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
              placeholder="kora"
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
  const [payees, setPayees] = useState(policy.allowlist.join("\n"));
  const [blocked, setBlocked] = useState(policy.blocklist.join("\n"));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const per = parseToken(perPayment || "0", token.decimals);
  const day = parseToken(perDay || "0", token.decimals);
  const allow = lines(payees);
  const block = lines(blocked);
  const badAccount = [...allow, ...block].find((a) => !ACCOUNT.test(a) || a.length < 2 || a.length > 64);
  const both = allow.find((a) => block.includes(a));
  const problem =
    per === null || day === null
      ? `Enter amounts in ${token.symbol}, for example 100 or 100.50`
      : BigInt(per) > BigInt(day)
        ? "The per-payment cap cannot be more than the daily cap"
        : badAccount
          ? `${badAccount} is not a NEAR account id`
          : both
            ? `${both} cannot be both allowed and blocked`
            : null;

  const save = async () => {
    if (problem || per === null || day === null) return;
    setBusy(true);
    setError(null);
    const update = {
      per_payment_cap: per,
      daily_cap: day,
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
              <input className="num" inputMode="decimal" value={perPayment} onChange={(e) => setPerPayment(e.target.value)} placeholder="100" />
              <span className="suffix">{token.symbol}</span>
            </span>
          </label>
          <label className="field">
            <span className="label">Per day</span>
            <span className="input-group">
              <input className="num" inputMode="decimal" value={perDay} onChange={(e) => setPerDay(e.target.value)} placeholder="500" />
              <span className="suffix">{token.symbol}</span>
            </span>
          </label>
        </div>
        <label className="field">
          <span className="label">Payees Keel may pay alone</span>
          <textarea className="mono-input" rows={3} value={payees} onChange={(e) => setPayees(e.target.value)} placeholder={"northwind.near\npayroll.kora.near"} />
          <span className="hint">One NEAR account per line</span>
        </label>
        <label className="field">
          <span className="label">Blocked addresses</span>
          <textarea className="mono-input" rows={2} value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder="Never pay these" />
        </label>
        <label className="field">
          <span className="label">Reason for the ledger</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Initial limits" />
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
          <input className="mono-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="northwind.testnet" autoFocus />
        </label>
        <label className="field">
          <span className="label">Amount</span>
          <span className="input-group">
            <input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="80" />
            <span className="suffix">{props.token.symbol}</span>
          </span>
          <span className="hint">Vault holds {formatToken(props.balance, props.token.decimals)} {props.token.symbol}</span>
        </label>
        <label className="field">
          <span className="label">Memo</span>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Invoice 1042" />
        </label>
        {(error || (to && amount && problem)) && <p className="error">{error ?? problem}</p>}
        <button className="btn primary lg block" onClick={pay} disabled={busy || Boolean(problem)}>
          {busy ? "Approve in your wallet" : "Pay from the vault"}
        </button>
      </section>
    </Overlay>
  );
}
