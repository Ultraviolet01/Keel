import { useCallback, useEffect, useMemo, useState } from "react";
import type { NearWalletBase } from "@hot-labs/near-connect";
import {
  accountExists,
  companyLabel,
  connector,
  EXPLORER_TX,
  FACTORY_ID,
  formatNear,
  formatToken,
  spendableNear,
  roundUpNear,
  shortKey,
  validVaultName,
  vaultNameFrom,
  view,
  type FactoryConfig,
  type Policy,
  type TokenMetadata,
} from "./near";

const viewAs = new URLSearchParams(window.location.search).get("view");

export default function App() {
  const [wallet, setWallet] = useState<NearWalletBase | null>(null);
  const [accountId, setAccountId] = useState<string | null>(viewAs);
  const [config, setConfig] = useState<FactoryConfig | null>(null);
  const [vaults, setVaults] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = Boolean(viewAs);

  // Wallet session: restore on load, follow sign-in and sign-out.
  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    connector.on("wallet:signIn", (e) => {
      if (cancelled) return;
      setWallet(e.wallet);
      setAccountId(e.accounts[0]?.accountId ?? null);
    });
    connector.on("wallet:signOut", () => {
      if (cancelled) return;
      setWallet(null);
      setAccountId(null);
      setVaults(null);
      setSelected(null);
    });
    connector
      .wallet()
      .then(async (w) => {
        const [first] = await w.getAccounts();
        if (!cancelled && first) {
          setWallet(w);
          setAccountId(first.accountId);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [readOnly]);

  useEffect(() => {
    view<FactoryConfig>(FACTORY_ID, "get_config").then(setConfig).catch((e) => setError(String(e)));
  }, []);

  const loadVaults = useCallback(async (owner: string, select?: string) => {
    const list = await view<string[]>(FACTORY_ID, "get_vaults_for_owner", { owner_id: owner });
    setVaults(list);
    setSelected((current) => select ?? (current && list.includes(current) ? current : list[0] ?? null));
    return list;
  }, []);

  useEffect(() => {
    if (accountId) loadVaults(accountId).catch((e) => setError(String(e)));
  }, [accountId, loadVaults]);

  const signIn = async () => {
    setError(null);
    try {
      const w = await connector.connect();
      const [first] = await w.getAccounts();
      setWallet(w);
      setAccountId(first?.accountId ?? null);
    } catch (e) {
      if (!String(e).toLowerCase().includes("reject")) setError(String(e));
    }
  };

  const signOut = async () => {
    if (wallet) await connector.disconnect(wallet);
    setWallet(null);
    setAccountId(null);
    setVaults(null);
    setSelected(null);
  };

  if (!accountId) return <SignIn onConnect={signIn} error={error} />;

  if (vaults === null || !config) {
    return (
      <Shell>
        <p className="muted pad">Loading your companies</p>
      </Shell>
    );
  }

  const creating = vaults.length === 0 || adding;

  return (
    <div className="app">
      <Sidebar
        accountId={accountId}
        vaults={vaults}
        selected={creating ? null : selected}
        readOnly={readOnly}
        onSelect={(v) => {
          setAdding(false);
          setSelected(v);
        }}
        onAdd={() => setAdding(true)}
        onSignOut={signOut}
      />
      <main className="main">
        {readOnly && (
          <div className="banner">
            Viewing <span className="mono">{accountId}</span> read-only. Connect a wallet to create or manage your own companies.
          </div>
        )}
        {creating ? (
          <CreateCompany
            accountId={accountId}
            config={config}
            wallet={wallet}
            readOnly={readOnly}
            firstCompany={vaults.length === 0}
            onCancel={vaults.length > 0 ? () => setAdding(false) : undefined}
            onCreated={async (vaultId) => {
              await loadVaults(accountId, vaultId);
              setAdding(false);
            }}
          />
        ) : (
          selected && <Overview key={selected} vaultId={selected} />
        )}
      </main>
    </div>
  );
}

// -------------------------------------------------------------------- sign in

function SignIn({ onConnect, error }: { onConnect: () => void; error: string | null }) {
  return (
    <div className="signin">
      <header className="signin-top">
        <span className="wordmark">KEEL</span>
        <span className="pill">Testnet</span>
      </header>
      <section className="signin-body">
        <div className="signin-copy">
          <h1>Open a vault for your company</h1>
          <p className="lead">
            Connect a NEAR wallet. Keel creates a vault that you own, and its agent can only pay inside the limits you
            set.
          </p>
          <button className="btn primary lg" onClick={onConnect}>
            Connect wallet
          </button>
          {error && <p className="error">{error}</p>}
          <p className="muted small">
            No wallet yet? Install{" "}
            <a href="https://meteorwallet.app" target="_blank" rel="noreferrer">
              Meteor Wallet
            </a>
            , switch it to testnet and create a free account, then fund it at{" "}
            <a href="https://near-faucet.io" target="_blank" rel="noreferrer">
              near-faucet.io
            </a>
            .
          </p>
        </div>
        <ol className="signin-steps">
          <li>
            <span className="step-num">1</span>
            <div>
              <h3>Name your company</h3>
              <p>One vault per company, owned by your wallet. Keel never holds your key.</p>
            </div>
          </li>
          <li>
            <span className="step-num">2</span>
            <div>
              <h3>Set your limits</h3>
              <p>The vault starts with none, so nothing moves alone until you decide how much can.</p>
            </div>
          </li>
          <li>
            <span className="step-num">3</span>
            <div>
              <h3>Keel keeps watch</h3>
              <p>The agent pays inside your limits and asks you about everything else.</p>
            </div>
          </li>
        </ol>
      </section>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="signin">
      <header className="signin-top">
        <span className="wordmark">KEEL</span>
      </header>
      {children}
    </div>
  );
}

// -------------------------------------------------------------------- sidebar

function Sidebar(props: {
  accountId: string;
  vaults: string[];
  selected: string | null;
  readOnly: boolean;
  onSelect: (v: string) => void;
  onAdd: () => void;
  onSignOut: () => void;
}) {
  return (
    <aside className="sidebar">
      <span className="wordmark">KEEL</span>
      <div className="section-label">Companies</div>
      <nav className="companies">
        {props.vaults.map((v) => (
          <button
            key={v}
            className={`company ${props.selected === v ? "active" : ""}`}
            onClick={() => props.onSelect(v)}
          >
            <span className="company-name">{companyLabel(v)}</span>
            <span className="mono tiny muted">{v}</span>
          </button>
        ))}
        {!props.readOnly && (
          <button className={`company add ${props.selected === null ? "active" : ""}`} onClick={props.onAdd}>
            + Add company
          </button>
        )}
      </nav>
      <div className="sidebar-foot">
        <span className="dot live" />
        <div className="foot-text">
          <span className="small">{props.readOnly ? "Read-only" : "Signed in"}</span>
          <span className="mono tiny muted">{props.accountId}</span>
        </div>
        {!props.readOnly && (
          <button className="btn ghost sm" onClick={props.onSignOut}>
            Sign out
          </button>
        )}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------ create company

type NameState = "empty" | "invalid" | "checking" | "taken" | "free";

function CreateCompany(props: {
  accountId: string;
  config: FactoryConfig;
  wallet: NearWalletBase | null;
  readOnly: boolean;
  firstCompany: boolean;
  onCancel?: () => void;
  onCreated: (vaultId: string) => Promise<void>;
}) {
  const [company, setCompany] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [nameState, setNameState] = useState<NameState>("empty");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const deposit = useMemo(() => roundUpNear(props.config.min_vault_deposit), [props.config]);
  const vaultId = name ? `${name}.${FACTORY_ID}` : "";

  useEffect(() => {
    if (!nameEdited) setName(vaultNameFrom(company));
  }, [company, nameEdited]);

  // Is the vault name valid and still free?
  useEffect(() => {
    if (!name) return setNameState("empty");
    if (!validVaultName(name)) return setNameState("invalid");
    setNameState("checking");
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const taken = await accountExists(`${name}.${FACTORY_ID}`);
        if (!stale) setNameState(taken ? "taken" : "free");
      } catch {
        if (!stale) setNameState("free");
      }
    }, 350);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [name]);

  const create = async () => {
    if (!props.wallet) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await props.wallet.signAndSendTransaction({
        signerId: props.accountId,
        receiverId: FACTORY_ID,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "create_vault",
              args: { name },
              gas: "300000000000000",
              deposit: deposit.toString(),
            },
          },
        ],
      });
      setTxHash(outcome.transaction.hash);
      const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
      const created = status.SuccessValue ? JSON.parse(atob(status.SuccessValue)) : null;
      if (!created) {
        setError("The vault could not be created, and your deposit was sent back. Try another name.");
        return;
      }
      await props.onCreated(created);
    } catch (e) {
      const msg = String(e);
      setError(msg.toLowerCase().includes("reject") ? "You cancelled the transaction in your wallet." : msg);
    } finally {
      setBusy(false);
    }
  };

  const nameHint: Record<NameState, string> = {
    empty: "Lowercase letters, digits, - or _",
    invalid: "Use 2 to 32 lowercase letters, digits, - or _, starting and ending with a letter or digit",
    checking: "Checking",
    taken: "That name is taken",
    free: "Available",
  };

  return (
    <div className="page narrow">
      <h1>{props.firstCompany ? "Create your company's vault" : "Add a company"}</h1>
      <p className="lead">
        Your vault holds the company's USDC. You own it from your wallet, and it starts with no limits, so Keel's agent
        can't pay anything on its own until you set them.
      </p>

      <div className="card form">
        <label className="field">
          <span className="label">Company name</span>
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Kora Supply"
            autoFocus
            disabled={props.readOnly}
          />
        </label>
        <label className="field">
          <span className="label">Vault address</span>
          <div className="addr-input">
            <input
              className="mono"
              value={name}
              onChange={(e) => {
                setNameEdited(true);
                setName(e.target.value.toLowerCase());
              }}
              placeholder="kora-supply"
              disabled={props.readOnly}
            />
            <span className="mono suffix">.{FACTORY_ID}</span>
          </div>
          <span className={`hint ${nameState}`}>{nameHint[nameState]}</span>
        </label>

        <ul className="facts">
          <li>
            <span>Owner</span>
            <span className="mono">{props.accountId}</span>
          </li>
          <li>
            <span>Keel's agent</span>
            <span>
              Can only pay inside your limits or propose payments{" "}
              <span className="mono tiny muted">({shortKey(props.config.agent_key)})</span>
            </span>
          </li>
          <li>
            <span>Limits</span>
            <span>None until you set them</span>
          </li>
          <li>
            <span>Deposit</span>
            <span>
              <strong className="num">{formatNear(deposit)} NEAR</strong>
              <span className="muted"> stays in the vault for its storage and the agent's gas</span>
            </span>
          </li>
        </ul>

        {error && <p className="error">{error}</p>}
        {txHash && (
          <p className="small muted">
            Transaction{" "}
            <a href={EXPLORER_TX + txHash} target="_blank" rel="noreferrer" className="mono">
              {txHash.slice(0, 10)}…
            </a>
          </p>
        )}

        <div className="actions">
          {props.onCancel && (
            <button className="btn ghost" onClick={props.onCancel} disabled={busy}>
              Cancel
            </button>
          )}
          <button
            className="btn primary"
            onClick={create}
            disabled={props.readOnly || busy || nameState !== "free" || !company.trim()}
          >
            {busy ? "Confirm in your wallet" : `Create ${vaultId || "vault"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ vaultId }: { vaultId: string }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [token, setToken] = useState<TokenMetadata | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [gas, setGas] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const p = await view<Policy>(vaultId, "get_policy");
      setPolicy(p);
      const [meta, bal, near] = await Promise.all([
        view<TokenMetadata>(p.token_id, "ft_metadata"),
        view<string>(p.token_id, "ft_balance_of", { account_id: vaultId }),
        spendableNear(vaultId),
      ]);
      setToken(meta);
      setBalance(bal);
      setGas(near);
    })().catch((e) => setError(String(e)));
  }, [vaultId]);

  if (error) {
    return (
      <div className="page">
        <h1>{companyLabel(vaultId)}</h1>
        <p className="error">
          This vault could not be read. It may have been created before the current vault version. {error}
        </p>
      </div>
    );
  }
  if (!policy || !token || balance === null) return <p className="muted pad">Loading {vaultId}</p>;

  const noLimits = policy.per_payment_cap === "0" && policy.daily_cap === "0";
  const amount = (raw: string) => `${formatToken(raw, token.decimals)} ${token.symbol}`;
  const legacyAgent = policy.agent_id;
  const agentConnected = Boolean(policy.agent_key);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{companyLabel(vaultId)}</h1>
          <p className="mono small muted">{vaultId}</p>
        </div>
        <span className={`pill ${policy.paused ? "warn" : "ok"}`}>{policy.paused ? "Paused" : "Running"}</span>
      </header>

      {noLimits && (
        <div className="callout">
          <div>
            <h3>No limits yet</h3>
            <p>
              Keel's agent can't pay anything on its own until you set a per-payment cap, a daily cap and the payees it
              may pay. It can still propose payments for you to approve.
            </p>
          </div>
        </div>
      )}

      <section className="stats">
        <div className="stat">
          <span className="label">Balance</span>
          <span className="figure">{formatToken(balance, token.decimals)}</span>
          <span className="muted small">{token.symbol}</span>
        </div>
        <div className="stat">
          <span className="label">Per payment</span>
          <span className="figure">{policy.per_payment_cap === "0" ? "Not set" : formatToken(policy.per_payment_cap, token.decimals)}</span>
          <span className="muted small">{policy.per_payment_cap === "0" ? "Every payment needs you" : token.symbol}</span>
        </div>
        <div className="stat">
          <span className="label">Per day</span>
          <span className="figure">{policy.daily_cap === "0" ? "Not set" : formatToken(policy.daily_cap, token.decimals)}</span>
          <span className="muted small">
            {policy.daily_cap === "0" ? "Nothing moves alone" : `${amount(policy.spent_today)} used today`}
          </span>
        </div>
        <div className="stat">
          <span className="label">Gas for Keel</span>
          <span className="figure">{gas === null ? "–" : formatNear(gas)}</span>
          <span className="muted small">NEAR spendable, after storage</span>
        </div>
      </section>

      <section className="card list">
        <h2>Vault</h2>
        <ul className="facts">
          <li>
            <span>Owner</span>
            <span className="mono">{policy.owner_id}</span>
          </li>
          <li>
            <span>Keel's agent</span>
            <span>
              {legacyAgent ? (
                <>
                  Separate agent account <span className="mono tiny muted">{legacyAgent}</span>{" "}
                  <span className="muted small">(earlier vault version)</span>
                </>
              ) : agentConnected ? (
                <>
                  <span className="dot live" /> Connected{" "}
                  <span className="mono tiny muted">{shortKey(policy.agent_key as string)}</span>
                </>
              ) : (
                <>
                  <span className="dot off" /> Not connected
                </>
              )}
            </span>
          </li>
          <li>
            <span>Allowed payees</span>
            <span>{policy.allowlist.length === 0 ? "None yet" : policy.allowlist.join(", ")}</span>
          </li>
          <li>
            <span>Blocked addresses</span>
            <span>{policy.blocklist.length}</span>
          </li>
          <li>
            <span>Token</span>
            <span className="mono">{policy.token_id}</span>
          </li>
          <li>
            <span>Deposit address</span>
            <span className="mono">{vaultId}</span>
          </li>
        </ul>
      </section>
    </div>
  );
}
