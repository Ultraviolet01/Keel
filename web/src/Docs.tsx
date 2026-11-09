// Founder-facing guide at /docs. Developer setup stays in the repository README.

import { GuidePage, REPO } from "./guide";

const SECTIONS = [
  ["what", "What Keel is"],
  ["start", "Get started"],
  ["decides", "How Keel decides"],
  ["payees", "Payees"],
  ["bills", "Bills and invoices"],
  ["vendors", "Paying ordinary vendors"],
  ["chains", "Other chains"],
  ["approvals", "Approvals"],
  ["safety", "Safety"],
  ["faq", "Questions"],
] as const;

export default function Docs() {
  return (
    <GuidePage
      path="/docs"
      title="Keel docs"
      lead="How to set up Keel for your company, what it does on its own, and what always comes to you. Keel runs on NEAR testnet today, with test USDC."
      sections={SECTIONS}
    >
      <h2 id="what">What Keel is</h2>
      <p>
        Keel is an AI treasury agent for a company. Your money sits in a vault: a NEAR smart contract that you own. You set the rules on the
        vault: how much Keel may pay at once, how much per day, and who it may pay. Keel watches your bills and balances and pays inside those
        rules. Anything outside them comes to you as a proposal to approve or reject.
      </p>
      <p>
        The rules are enforced by the vault, not by Keel. Keel's key can only ask the vault to pay or to propose; it cannot change your limits,
        approve its own proposals or withdraw.
      </p>

      <h2 id="start">Get started</h2>
      <ol>
        <li>
          <b>Connect a wallet.</b> Click <b>Open app</b>, then <b>Connect wallet</b>, and pick a NEAR wallet set to testnet. Free testnet NEAR comes
          from <a href="https://near-faucet.io">near-faucet.io</a>.
        </li>
        <li>
          <b>Create your company.</b> Name it and click <b>Create vault</b>. It costs about 3.6 testnet NEAR, which pays the vault's storage and
          stays in the vault. Keel's agent is connected the moment the vault exists.
        </li>
        <li>
          <b>Set your limits.</b> Click <b>Set limits</b>: a per-payment cap, a daily cap and a cash buffer, the least the vault should ever hold. Until you set the caps, Keel can only propose.
        </li>
        <li>
          <b>Approve your payees.</b> Open <b>Payees</b> and add the vendors, people and wallets Keel may pay on its own.
        </li>
        <li>
          <b>Deposit USDC.</b> Click <b>Deposit</b> and send USDC on NEAR to the vault address shown. Test USDC comes from{" "}
          <a href="https://faucet.circle.com">faucet.circle.com</a> (pick NEAR Testnet).
        </li>
        <li>
          <b>Add your bills.</b> Click <b>Add bill</b>, or upload the invoice and let Claude fill in the form.
        </li>
      </ol>
      <p>The Overview page shows a checklist of these steps until they are done.</p>

      <h2 id="decides">How Keel decides</h2>
      <p>Keel checks each bill about three days before it is due, every 15 minutes. The vault puts every payment in one of three bands:</p>
      <table>
        <thead>
          <tr>
            <th>Band</th>
            <th>When</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Runs alone</td>
            <td>Approved payee, within the per-payment and daily caps</td>
            <td>Keel pays it and records the rule it used</td>
          </tr>
          <tr>
            <td>Needs approval</td>
            <td>New payee, over the per-payment cap, another chain, or the vault holds too little</td>
            <td>Keel proposes it with a plain-English reason; you approve or reject</td>
          </tr>
          <tr>
            <td>Blocked</td>
            <td>Blocklisted payee, vault paused, or the daily cap reached</td>
            <td>Nothing is paid or proposed; it is logged</td>
          </tr>
        </tbody>
      </table>
      <p>
        The vault pays each bill at most once, even if Keel restarts or is tricked into retrying. <b>Pause</b> in the sidebar stops every payment at
        once; <b>Resume</b> starts them again.
      </p>

      <h2 id="payees">Payees</h2>
      <p>
        A payee is a destination you approved: a name, a kind and a NEAR account. Approving one puts it on the vault's allowlist, so Keel may pay it
        within your caps. Get the account from the vendor directly, never from an email or invoice alone.
      </p>
      <ul>
        <li>
          <b>Vendor</b>, <b>Employee or contractor</b>: paid when their bills are due.
        </li>
        <li>
          <b>Company card wallet</b>: the wallet a crypto card spends from. Set a balance to keep, and Keel tops it back up when it runs low, at most
          once a day and within your caps.
        </li>
        <li>
          <b>Bank off-ramp</b>: a deposit address that turns USDC into a bank transfer.
        </li>
        <li>
          <b>Your own wallet</b>: another wallet the company owns; it can also have a balance to keep.
        </li>
        <li>
          <b>Yield destination</b>: where idle cash earns. Tick <b>lending market</b> to use Burrow, NEAR's lending protocol: the money sits in your
          vault's own Burrow account as a yield investment, earning interest, and Keel withdraws it back to the vault when bills need it. Set the most Keel may move at once. Keel moves
          only cash above your buffer and the next 14 days of bills, once a day, and only with a cash buffer set.
        </li>
      </ul>
      <p>Removing a payee takes it off the allowlist. From then on, payments to it need your approval.</p>

      <h2 id="bills">Bills and invoices</h2>
      <p>
        A bill tells Keel what to pay, to whom, how much and when. Add it from the Overview page with <b>Add bill</b>. Each bill has a category
        (software, domains and hosting, contractors, payroll, rent, taxes, card top-up, other) and repeats once, every month or every year.
        Bills are saved on the vault with your signature: Keel cannot add one itself.
      </p>
      <p>
        <b>Critical bills and the cash buffer:</b> tick <b>Critical</b> for bills that must never wait, like payroll. When paying a bill would take the
        vault below your cash buffer, Keel pays critical bills first and asks you about them; other bills show <b>Deferred: cash buffer</b> and wait
        until they are due, then come to you. The vault enforces the buffer itself.
      </p>
      <p>
        <b>From an invoice:</b> upload a PDF or photo (up to 3 MB) in the Add bill form. Claude reads the vendor, amount, due date, invoice number
        and category and fills in the form. You check every field before you sign. The file is not stored. If the invoice asks you to pay an
        address that is not one of your payees, the form says so, and Keel will propose that payment to you instead of paying it alone. To
        add several at once, click <b>Import invoices</b>: drop up to 10 files, check the rows Claude drafts, and sign them all in one
        transaction.
      </p>
      <p>
        <b>Upcoming payments</b> on the Overview page lists your bills with their status: Scheduled, Needs approval or Paid. The balance chart
        shows what your bills will take out of the vault over the next 14 days, and warns you when they add up to more than it holds.
      </p>

      <h2 id="vendors">Paying ordinary vendors</h2>
      <p>Most vendors bill a card or a bank account. Keel always pays a destination you approved; here is what to approve for each kind of vendor.</p>
      <table>
        <thead>
          <tr>
            <th>The vendor takes</th>
            <th>Approve as the payee</th>
            <th>What Keel does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>A NEAR account or crypto address</td>
            <td>The vendor's account</td>
            <td>Pays each bill when due, within your caps</td>
          </tr>
          <tr>
            <td>"Pay with USDC" on the invoice</td>
            <td>Nothing: the address changes with each invoice</td>
            <td>Proposes each payment to you</td>
          </tr>
          <tr>
            <td>A card (domains, software, cloud)</td>
            <td>Your crypto card's wallet, with a balance to keep</td>
            <td>Keeps the card funded; vendors charge the card as usual</td>
          </tr>
          <tr>
            <td>Bank transfer only (rent, taxes)</td>
            <td>A bank off-ramp deposit address</td>
            <td>Pays it like any bill; the off-ramp sends the bank transfer</td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">On testnet there is no real card or off-ramp; test accounts stand in for them.</p>

      <h2 id="chains">Other chains</h2>
      <p>
        Your vault also has its own address on Base, Ethereum, Arbitrum and Optimism, through NEAR Chain Signatures. The address is the same on every
        chain and only the vault can sign for it. Open <b>Wallets</b> to see it.
      </p>
      <p>
        A bill on another chain is paid from that address, so it needs USDC and a little ETH for gas on that chain. Keel says how much is missing.
        Payments on other chains always come to you for approval. After you approve, NEAR's signing network signs the transfer and Keel sends it on
        its next run.
      </p>

      <h2 id="approvals">Approvals</h2>
      <p>
        Proposals wait under <b>Approvals</b>. Each one shows the payee's full address, the amount, the rule that sent it to you and Keel's reason.
        Text copied from an invoice is marked as unverified. Approving signs the payment with your wallet; rejecting closes it. Some proposals,
        such as cross-chain moves, carry a deadline; after it, Keel proposes again with a fresh one.
      </p>
      <p>
        <b>Activity</b> lists every payment and proposal. <b>Export</b> on the Overview page downloads them as a CSV for your accountant.
      </p>

      <h2 id="safety">Safety</h2>
      <ul>
        <li>Only your wallet can change limits, payees, bills or the blocklist, approve proposals, pause, or withdraw.</li>
        <li>Keel's key can only call the vault's pay and propose methods, with a small gas allowance. If it leaked, it still could not pay past your limits.</li>
        <li>
          <b>Rules</b> lets you remove Keel's key at any time. Your money stays in the vault and you can still withdraw it, even while paused.
        </li>
        <li>Every rule change is recorded on chain with the old value, the new value and your reason.</li>
        <li>Keel never takes a new payment address from an invoice or email by itself; a new address always comes to you.</li>
      </ul>

      <h2 id="faq">Questions</h2>
      <p>
        <b>Does Keel hold my money?</b> No. The vault holds it, and you own the vault.
      </p>
      <p>
        <b>What if Keel goes offline?</b> Nothing moves. Bills wait, and you can still pay, withdraw and approve from the app.
      </p>
      <p>
        <b>Can I see other companies?</b> Only read-only: open <code>/app?view=&lt;account&gt;</code> to see any founder's vaults with live data.
        Nothing there can sign.
      </p>
      <p>
        <b>Is this real money?</b> Not yet. Keel runs on NEAR testnet with test USDC. The code, the rules and the Chain Signatures payments are
        real; the tokens are test tokens.
      </p>
      <p>
        <b>Where is the code?</b> Everything is open source on <a href={REPO}>GitHub</a>, including how to run the agent and the tests.
      </p>
    </GuidePage>
  );
}
