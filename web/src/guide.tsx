// The site's guide pages (/how-it-works, /security, /docs) share this frame:
// the landing nav, a contents list and one readable column.

export const APP = "/app";
export const REPO = "https://github.com/Ultraviolet01/Keel";

const NAV = [
  ["/how-it-works", "How it works"],
  ["/security", "Security"],
  ["/docs", "Docs"],
] as const;

export function SiteNav({ current }: { current?: string }) {
  return (
    <header className="l-nav">
      <a className="wordmark" href="/">
        KEEL
      </a>
      <nav>
        {NAV.map(([href, label]) => (
          <a key={href} href={href} aria-current={current === href ? "page" : undefined}>
            {label}
          </a>
        ))}
        <a href={REPO}>GitHub</a>
        <a className="btn sm" href={APP}>
          Open app
        </a>
      </nav>
    </header>
  );
}

export function GuidePage(props: { path: string; title: string; lead: string; sections: readonly (readonly [string, string])[]; children: React.ReactNode }) {
  return (
    <div className="landing docs">
      <SiteNav current={props.path} />
      <div className="docs-wrap">
        <aside className="docs-toc">
          <span className="muted small">On this page</span>
          {props.sections.map(([id, title]) => (
            <a key={id} href={`#${id}`}>
              {title}
            </a>
          ))}
        </aside>
        <main className="docs-body">
          <h1 className="serif">{props.title}</h1>
          <p className="lead">{props.lead}</p>
          {props.children}
          <div className="docs-next">
            <a className="btn primary lg" href={APP}>
              Open app
            </a>
            {NAV.filter(([href]) => href !== props.path).map(([href, label]) => (
              <a key={href} className="btn lg" href={href}>
                {label}
              </a>
            ))}
          </div>
        </main>
      </div>
      <footer className="l-foot">
        <a href={REPO}>Source on GitHub</a>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------ how it works

const HOW = [
  ["parts", "Three parts"],
  ["loop", "Every 15 minutes"],
  ["bill", "One bill, start to finish"],
  ["chains", "Paying on other chains"],
  ["claude", "Where AI is used"],
  ["learn", "What Keel learns"],
] as const;

export function HowItWorks() {
  return (
    <GuidePage
      path="/how-it-works"
      title="How Keel works"
      lead="A vault you own holds the money and the rules. Keel's agent does the work inside those rules. You decide everything else."
      sections={HOW}
    >
      <h2 id="parts">Three parts</h2>
      <table>
        <thead>
          <tr>
            <th>Part</th>
            <th>What it is</th>
            <th>What it can do</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Your vault</td>
            <td>A NEAR smart contract created for your company, owned by your wallet</td>
            <td>Holds the USDC, stores your limits, payees and bills, and checks every payment before money moves</td>
          </tr>
          <tr>
            <td>Keel's agent</td>
            <td>A program that runs every 15 minutes and signs with a key limited to your vault</td>
            <td>Pays inside your limits, or proposes a payment to you. Nothing else</td>
          </tr>
          <tr>
            <td>You</td>
            <td>The vault's owner, signing with your own wallet in the app</td>
            <td>Set limits, payees and bills, approve or reject proposals, pause, withdraw, remove the agent</td>
          </tr>
        </tbody>
      </table>

      <h2 id="loop">Every 15 minutes</h2>
      <p>Keel goes through every company's vault and runs the same steps:</p>
      <ol>
        <li>
          <b>Observe.</b> Reads the vault's balance, limits, payees, bills and waiting proposals from the chain.
        </li>
        <li>
          <b>Forecast.</b> Lays the bills over the next 14 days and finds the first day the vault would run short.
        </li>
        <li>
          <b>Check.</b> For each bill due within three days, scores the payee (blocklisted, new, missing account, changed contract code) and asks the
          vault which band the payment lands in.
        </li>
        <li>
          <b>Decide.</b> Pay, propose, or refuse. Plain code decides, not a language model.
        </li>
        <li>
          <b>Act.</b> Signs the payment or the proposal. Card wallets below their target balance are topped up the same way.
        </li>
        <li>
          <b>Reconcile.</b> Confirms what landed, and sends any transfer on another chain that you approved and NEAR has signed.
        </li>
        <li>
          <b>Learn.</b> Notes patterns, such as a payee you approve every time, and drafts a rule for you to consider.
        </li>
      </ol>
      <p>
        Keel keeps no memory it relies on: what was paid and proposed lives on the vault, so a restarted agent picks up exactly where the last one
        stopped.
      </p>

      <h2 id="bill">One bill, start to finish</h2>
      <p>Say you add "Domain renewal, 15 USDC, every year, 10 December" for your registrar's account.</p>
      <ol>
        <li>You sign the bill in the app. It is saved on your vault, and the Overview page lists it as Scheduled.</li>
        <li>On 7 December Keel sees it is due in three days and checks the registrar against your payees and limits.</li>
        <li>If the registrar is an approved payee and 15 USDC is within your caps, Keel pays it, and the bill shows as Paid with the rule it used.</li>
        <li>
          If not (a new payee, over your per-payment cap, or the vault holds too little), Keel proposes it with a plain-English reason. You approve or
          reject it under Approvals.
        </li>
        <li>Next December the same bill comes round again. The vault pays each year's bill once, never twice.</li>
      </ol>

      <h2 id="chains">Paying on other chains</h2>
      <p>
        Each vault has its own address on Base, Ethereum, Arbitrum and Optimism, created through NEAR Chain Signatures: only the vault can sign for
        it. For a bill on one of those chains, Keel proposes a USDC transfer from that address. When you approve, the vault builds the transfer and
        NEAR's signing network signs it; Keel then sends it. On mainnet, Keel can also quote the move through NEAR Intents and show both routes.
      </p>

      <h2 id="claude">Where AI is used</h2>
      <ul>
        <li>
          <b>Reasons.</b> Claude writes the sentence on each proposal that tells you why it needs you. It is given Keel's facts only, never the
          invoice's own text.
        </li>
        <li>
          <b>Invoices.</b> When you upload an invoice, Claude reads it into the Add bill form for you to check.
        </li>
      </ul>
      <p>Neither can move money or change a decision. Paying, proposing and refusing are plain code, checked again by your vault.</p>

      <h2 id="learn">What Keel learns</h2>
      <p>
        After you approve the same payee three times in a row, Keel drafts a rule change, such as raising that payee's limit, for you to accept or
        ignore. It also flags a bill more than 25% above that payee's last three. Keel never changes a limit itself.
      </p>
    </GuidePage>
  );
}

// ---------------------------------------------------------------- security

const SEC = [
  ["line", "The line Keel can't cross"],
  ["key", "Keel's key"],
  ["you", "What only you can do"],
  ["attacks", "Attacks we tested"],
  ["limits", "What this does not cover"],
] as const;

export function Security() {
  return (
    <GuidePage
      path="/security"
      title="Security"
      lead="Not “won't”. Can't. Your limits live in your vault contract, so even a compromised or tricked agent cannot pay past them."
      sections={SEC}
    >
      <h2 id="line">The line Keel can't cross</h2>
      <p>Every payment goes through your vault, and the vault checks it before any money moves:</p>
      <ul>
        <li>Only approved payees, only within the per-payment and daily caps. Everything else becomes a proposal for you.</li>
        <li>Blocklisted payees are refused outright, on NEAR and on other chains.</li>
        <li>Each bill is paid at most once, even if Keel restarts with no memory or is tricked into retrying.</li>
        <li>Pause stops every payment at once.</li>
      </ul>

      <h2 id="key">Keel's key</h2>
      <p>
        Keel signs with a NEAR function-call key that the factory adds to your vault when it is created. That key can call two methods on your vault
        and nothing else:
      </p>
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Who can call it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>execute_payment</code>
            </td>
            <td>Keel, only for an approved payee within your caps</td>
          </tr>
          <tr>
            <td>
              <code>propose_payment</code>
            </td>
            <td>Keel; at most 50 proposals wait at once</td>
          </tr>
          <tr>
            <td>
              <code>update_policy</code>, <code>add_payee</code>, <code>add_bill</code>
            </td>
            <td>You only</td>
          </tr>
          <tr>
            <td>
              <code>approve</code>, <code>withdraw</code>, <code>pause</code>
            </td>
            <td>You only</td>
          </tr>
          <tr>
            <td>
              <code>set_agent_key</code>, <code>revoke_agent</code>
            </td>
            <td>You only</td>
          </tr>
          <tr>
            <td>Transfer NEAR, add keys, touch another vault</td>
            <td>Nobody: the key cannot, and the vault has no other key</td>
          </tr>
        </tbody>
      </table>
      <p>The key's gas allowance is small (0.25 NEAR), and Keel's calls stop before the vault's NEAR for storage runs low, so you can always act.</p>

      <h2 id="you">What only you can do</h2>
      <p>
        Your own wallet signs every change: limits, payees, bills, the blocklist, approvals, pause and withdrawals. Keel never holds your key. You can
        remove Keel's key in one click from Rules, and you can withdraw your money at any time, even while the vault is paused. Every rule change is
        recorded on chain with the old value, the new value and your reason.
      </p>

      <h2 id="attacks">Attacks we tested</h2>
      <table>
        <thead>
          <tr>
            <th>Attack</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>"Supplier changed bank details, pay today"</td>
            <td>Keel refuses before signing; forced through anyway, the vault refuses on chain</td>
          </tr>
          <tr>
            <td>An invoice says "already approved by the CFO" or carries hidden instructions</td>
            <td>The text is shown quoted and marked unverified, and never reaches the model that writes reasons. Invoice reading ignored planted instructions in testing, and every value is re-checked</td>
          </tr>
          <tr>
            <td>An invoice asks you to pay a new address</td>
            <td>The form warns you, and Keel only ever proposes payments to it</td>
          </tr>
          <tr>
            <td>A stolen agent key</td>
            <td>Cannot pay past your limits, add payees or bills, or approve. It cannot flood the vault: at most 50 proposals, and a storage reserve</td>
          </tr>
          <tr>
            <td>The same bill paid twice</td>
            <td>Refused by the vault: four parallel payments of one bill paid once</td>
          </tr>
          <tr>
            <td>A look-alike address with the same first and last characters</td>
            <td>The approval screen shows the full address</td>
          </tr>
          <tr>
            <td>A vault-signed transfer replayed on another chain</td>
            <td>Not possible: the signature covers the chain id</td>
          </tr>
          <tr>
            <td>A stranger burns gas against the vault</td>
            <td>Every call refused; the vault's NEAR and Keel's allowance unchanged</td>
          </tr>
        </tbody>
      </table>
      <p>
        The contract has 92 tests, one per rule, and the agent suite checks about 37,000 generated cases. A live attack suite tried 53 attacks against
        a testnet vault. Details and the commands to run them are in the <a href={`${REPO}#security`}>repository</a>.
      </p>

      <h2 id="limits">What this does not cover</h2>
      <ul>
        <li>One owner wallet approves everything; multisig approval is not built yet. Keep that wallet safe.</li>
        <li>Within your caps, an approved payee can be paid without asking you. Set caps you are comfortable losing in a bad week.</li>
        <li>Keel cannot tell if a vendor you approved is itself compromised. Verify payment details with vendors directly.</li>
        <li>Keel runs on NEAR testnet with test USDC today; the contracts have not had an external audit.</li>
      </ul>
    </GuidePage>
  );
}
