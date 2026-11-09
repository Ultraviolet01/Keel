import { useCallback, useEffect, useState } from "react";
import type { NearWalletBase } from "@hot-labs/near-connect";
import { connector, FACTORY_ID, view, type FactoryConfig } from "./near";
import { Sidebar, type Page } from "./Sidebar";
import { BillPanel, ImportPanel, PayeePanel, ConnectPanel, CreatePanel, ViewNotice, DepositPanel, LimitsPanel, PayPanel, type Send, type SendBatch } from "./panels";
import { Activity, Approvals, Overview, Payees, Rules, Wallets, type PageProps } from "./pages";
import { keelState, useVault } from "./vault";
import { describeCall, proposalCall, savedTeams, saveTeams, teamsOf } from "./multisig";

// `?view=<account>` shows a founder's companies read-only, without a wallet.
const viewAs = new URLSearchParams(window.location.search).get("view");
/** NEAR account id rules: 2 to 64 characters, lowercase parts joined by . with - or _ inside. */
const isAccountId = (id: string) => id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);

export default function App() {
  const [wallet, setWallet] = useState<NearWalletBase | null>(null);
  const [accountId, setAccountId] = useState<string | null>(viewAs);
  const [config, setConfig] = useState<FactoryConfig | null>(null);
  const [vaults, setVaults] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [panel, setPanel] = useState<"add" | "limits" | "deposit" | "pay" | "bill" | "payee" | "import" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Multisig accounts (Sputnik DAOs / Trezu treasuries) whose companies this browser lists too.
  const [teams, setTeams] = useState<string[]>(savedTeams);
  const readOnly = Boolean(viewAs);
  const vault = useVault(selected);
  // Vault names are first come, first served, so the app always shows who owns
  // a vault, and checks the vault's own record against the factory's.
  const [factoryOwner, setFactoryOwner] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setFactoryOwner(undefined);
    if (!selected) return;
    view<string | null>(FACTORY_ID, "get_owner", { vault_id: selected }).then(setFactoryOwner, () => setFactoryOwner(undefined));
  }, [selected]);

  // Wallet session: restore on load and follow sign-in / sign-out.
  useEffect(() => {
    if (readOnly) return;
    let live = true;
    connector.on("wallet:signIn", (e) => {
      if (!live) return;
      setWallet(e.wallet);
      setAccountId(e.accounts[0]?.accountId ?? null);
    });
    connector.on("wallet:signOut", () => {
      if (!live) return;
      setWallet(null);
      setAccountId(null);
    });
    connector
      .wallet()
      .then(async (w) => {
        const [first] = await w.getAccounts();
        if (live && first) {
          setWallet(w);
          setAccountId(first.accountId);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [readOnly]);

  useEffect(() => {
    view<FactoryConfig>(FACTORY_ID, "get_config").then(setConfig, (e) => setError(String(e)));
  }, []);

  const loadVaults = useCallback(async (owner: string, select?: string) => {
    const owners = [owner, ...(readOnly ? [] : teams.filter((t) => t !== owner))];
    const lists = await Promise.all(
      owners.map((o) => view<string[]>(FACTORY_ID, "get_vaults_for_owner", { owner_id: o }).catch(() => [] as string[])),
    );
    const list = [...new Set(lists.flat())];
    setVaults(list);
    setSelected((cur) => select ?? (cur && list.includes(cur) ? cur : list.at(-1) ?? null));
  }, [readOnly, teams]);

  const addTeam = (team: string) => {
    const next = [...new Set([...teams, team])];
    saveTeams(next);
    setTeams(next);
  };

  // A connected member's teams: the multisigs that own Keel vaults and list this wallet.
  useEffect(() => {
    if (readOnly || !wallet || !accountId) return;
    let live = true;
    teamsOf(accountId, FACTORY_ID)
      .then((found) => {
        if (!live || found.length === 0) return;
        setTeams((cur) => {
          const next = [...new Set([...cur, ...found])];
          if (next.length === cur.length) return cur;
          saveTeams(next);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [readOnly, wallet, accountId]);

  useEffect(() => {
    if (!accountId) {
      setVaults(null);
      setSelected(null);
      return;
    }
    if (!isAccountId(accountId)) return; // shown as an invalid link, nothing to load
    loadVaults(accountId).catch((e) => setError(String(e)));
  }, [accountId, loadVaults]);

  const connect = async () => {
    setError(null);
    try {
      const w = await connector.connect();
      const [first] = await w.getAccounts();
      setWallet(w);
      setAccountId(first?.accountId ?? null);
    } catch (e) {
      if (!/reject|cancel|closed/i.test(String(e))) setError(String(e));
    }
  };

  const signOut = async () => {
    if (wallet) await connector.disconnect(wallet).catch(() => {});
    setWallet(null);
    setAccountId(null);
    setPage("overview");
  };

  const walletBatch: SendBatch = async (receiverId, calls) => {
    if (!wallet || !accountId) throw new Error("Connect your wallet first");
    const outcome = await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId,
      actions: calls.map((c) => ({ type: "FunctionCall" as const, params: { methodName: c.methodName, args: c.args, gas: c.gas, deposit: c.deposit } })),
    });
    return outcome as unknown as { transaction: { hash: string }; status: unknown };
  };

  const walletSend: Send = async (receiverId, methodName, args, opts = {}) => {
    if (!wallet || !accountId) throw new Error("Connect your wallet first");
    const outcome = await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId,
      actions: [
        {
          type: "FunctionCall",
          params: { methodName, args, gas: opts.gas ?? "30000000000000", deposit: opts.deposit ?? "0" },
        },
      ],
    });
    return outcome as unknown as { transaction: { hash: string }; status: unknown };
  };

  const d = vault.data;
  const multisig = d?.multisig ?? null;
  // A multisig-owned vault: the signed-in member files a DAO proposal instead
  // of calling the vault, and the members vote on it under Rules.
  const sendBatch: SendBatch = async (receiverId, calls) => {
    if (!multisig || receiverId !== selected) return walletBatch(receiverId, calls);
    const what = [...new Set(calls.map((c) => describeCall(c.methodName)))].join(", ");
    const outcome = await walletBatch(multisig.dao, [
      { methodName: "add_proposal", args: proposalCall(receiverId, calls, `Keel: ${what} on ${receiverId}`), gas: "50000000000000", deposit: multisig.bond },
    ]);
    const sv = (outcome.status as { SuccessValue?: string } | undefined)?.SuccessValue;
    const id = sv ? atob(sv) : null;
    setNotice(`Filed as ${id ? `proposal #${id}` : "a proposal"} in ${multisig.dao}: ${what}. It runs once enough members approve it under Rules.`);
    return outcome;
  };
  const send: Send = (receiverId, methodName, args, opts = {}) =>
    multisig && receiverId === selected
      ? sendBatch(receiverId, [{ methodName, args, gas: opts.gas ?? "30000000000000", deposit: opts.deposit ?? "0" }])
      : walletSend(receiverId, methodName, args, opts);

  const canAct = Boolean(wallet) && !readOnly && (!multisig || (accountId !== null && multisig.members.includes(accountId)));

  // 0. Read-only link to an invalid account, or to one with no companies.
  if (readOnly && accountId && (!isAccountId(accountId) || (vaults !== null && vaults.length === 0))) {
    return (
      <>
        <div className="backdrop" aria-hidden="true" />
        <ViewNotice accountId={accountId} invalid={!isAccountId(accountId)} />
      </>
    );
  }

  // 1. Not connected: the Connect wallet panel on a plain backdrop.
  if (!accountId) {
    return (
      <>
        <div className="backdrop" aria-hidden="true" />
        <ConnectPanel onConnect={connect} error={error} />
      </>
    );
  }

  // 2. Connected with no company yet: name the first one.
  if (vaults !== null && vaults.length === 0 && config) {
    return (
      <>
        <div className="backdrop" aria-hidden="true" />
        <CreatePanel
          accountId={accountId}
          config={config}
          first
          readOnly={!canAct}
          send={send}
          onCreated={async (v) => {
            await loadVaults(accountId, v);
            setPage("overview");
          }}
        />
      </>
    );
  }

  const status = d ? keelState(d.policy) : null;
  const pending = d ? d.proposals.filter((x) => x.status === "pending").length : 0;

  const togglePause = async () => {
    if (!selected || !d) return;
    setBusy(true);
    try {
      await send(selected, d.policy.paused ? "resume" : "pause", {}, { deposit: "1" });
      await vault.reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pageProps: PageProps | null =
    selected && d
      ? {
          vaultId: selected,
          data: d,
          canAct,
          send,
          reload: vault.reload,
          go: setPage,
          onSetLimits: () => setPanel("limits"),
          onDeposit: () => setPanel("deposit"),
          onNewPayment: () => setPanel("pay"),
          onAddBill: () => setPanel("bill"),
          onAddPayee: () => setPanel("payee"),
          onImport: () => setPanel("import"),
          accountId: accountId ?? "",
          onSignOut: readOnly ? undefined : signOut,
          onPauseToggle: togglePause,
          onTeam: (team: string) => {
            addTeam(team);
          },
        }
      : null;
  const PageView = { overview: Overview, approvals: Approvals, activity: Activity, payees: Payees, rules: Rules, wallets: Wallets }[page];

  return (
    <>
      <div className={`app ${panel ? "behind" : ""}`}>
        <Sidebar
          companies={(vaults ?? []).map((v) => ({ vaultId: v }))}
          selected={selected}
          page={page}
          pendingCount={pending}
          status={status}
          canAct={canAct}
          busy={busy}
          accountId={accountId}
          owner={vault.data?.policy.owner_id ?? null}
          onSignOut={readOnly ? undefined : signOut}
          onSelect={(v) => {
            setSelected(v);
            setPage("overview");
          }}
          onAdd={() => setPanel("add")}
          onAddTeam={readOnly ? undefined : async (team) => {
            addTeam(team);
          }}
          onPage={setPage}
          onPauseToggle={togglePause}
        />
        <main className="main">
          {readOnly && (
            <div className="banner">
              Viewing <span className="mono">{accountId}</span> read-only. Open the app without <span className="mono">?view=</span> to
              connect your own wallet.
            </div>
          )}
          {vault.data && factoryOwner !== undefined && factoryOwner !== vault.data.policy.owner_id ? (
            <div className="banner bad-banner">
              The factory lists <span className="mono">{factoryOwner ?? "no one"}</span> as this vault's owner, but the vault says{" "}
              <span className="mono">{vault.data.policy.owner_id}</span>. Do not deposit until this is explained.
            </div>
          ) : null}
          {multisig && !readOnly ? (
            <div className="banner">
              This vault belongs to the multisig <span className="mono">{multisig.dao}</span>
              {canAct ? ". Your changes are filed as proposals; they run once enough members approve them under Rules." : `. You are not one of its members, so you can only look.`}
            </div>
          ) : null}
          {notice && (
            <div className="banner ok-banner" role="status">
              {notice}{" "}
              <button className="link-btn" onClick={() => setNotice(null)}>Dismiss</button>
            </div>
          )}
          {vault.data && !multisig && !readOnly && accountId && vault.data.policy.owner_id !== accountId ? (
            <div className="banner bad-banner">
              You are signed in as <span className="mono">{accountId}</span>, but this vault belongs to{" "}
              <span className="mono">{vault.data.policy.owner_id}</span>. A similar name does not make it yours.
            </div>
          ) : null}
          {error && <p className="error">{error}</p>}
          {vault.error ? (
            <p className="error">This vault could not be read: {vault.error}</p>
          ) : pageProps ? (
            <div className="page-in" key={`${page}:${selected}`}>
              <PageView {...pageProps} />
            </div>
          ) : (
            <p className="muted">Loading {selected ?? "your companies"}</p>
          )}
        </main>
      </div>

      {panel === "add" && config && (
        <CreatePanel
          accountId={accountId}
          config={config}
          first={false}
          readOnly={!canAct}
          send={send}
          onClose={() => setPanel(null)}
          onCreated={async (v) => {
            await loadVaults(accountId, v);
            setPanel(null);
            setPage("overview");
          }}
        />
      )}
      {panel === "limits" && selected && d && (
        <LimitsPanel vaultId={selected} policy={d.policy} token={d.token} send={send} onClose={() => setPanel(null)} onSaved={vault.reload} />
      )}
      {panel === "pay" && selected && d && (
        <PayPanel vaultId={selected} token={d.token} balance={d.balance} send={send} onClose={() => setPanel(null)} onPaid={vault.reload} />
      )}
      {panel === "bill" && selected && d && (
        <BillPanel vaultId={selected} token={d.token} policy={d.policy} payees={d.payees} send={send} onClose={() => setPanel(null)} onSaved={vault.reload} />
      )}
      {panel === "import" && selected && d && (
        <ImportPanel vaultId={selected} token={d.token} policy={d.policy} payees={d.payees} sendBatch={sendBatch} onClose={() => setPanel(null)} onSaved={vault.reload} />
      )}
      {panel === "payee" && selected && d && (
        <PayeePanel vaultId={selected} token={d.token} policy={d.policy} agentMethods={d.agentMethods} send={send} onClose={() => setPanel(null)} onSaved={vault.reload} />
      )}
      {panel === "deposit" && selected && d && (
        <DepositPanel vaultId={selected} token={d.token} tokenId={d.policy.token_id} onClose={() => setPanel(null)} />
      )}
    </>
  );
}
