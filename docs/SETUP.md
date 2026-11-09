# Set up a company and run Keel

[Back to the README](../README.md)

## Create your company in the app

1. **Create your company.** In the app, click **Open app**, connect a NEAR testnet wallet holding about 4 NEAR (free from https://near-faucet.io), name your company and click **Create vault**. You see your vault, owned by you, with Keel's agent key already on it and no limits, so every payment needs your approval. The 3.86 NEAR deposit (`min_vault_deposit` on `keel.testnet`) pays the vault's storage and stays in it. Command line: `near contract call-function as-transaction keel.testnet create_vault json-args '{"name":"<company>"}' prepaid-gas '300 Tgas' attached-deposit '3.9 NEAR' sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send`.
2. **Set your limits.** Click **Set limits**: per payment, per day, a cash buffer, approved payees and blocked addresses. You see them under **Active rules**. Command line: `update_policy` with `{"update":{"per_payment_cap":"3000000","daily_cap":"10000000","min_balance":"1000000","allow":["<payee>.testnet"]},"reason":"initial limits"}` and 1 yoctoNEAR attached.
3. **Approve payees.** Open **Payees**, click **Approve a payee**: a name, the kind (vendor, employee, company card wallet, bank off-ramp, your own wallet, yield destination) and the NEAR account. A card or your own wallet can have a balance to keep; a yield destination has a most-per-move limit and can be marked as a lending market (Burrow). You see it as **Approved by you**.
4. **Deposit USDC.** Click **Deposit** and send Circle's testnet USDC from https://faucet.circle.com (network "Near Testnet") to your vault's account. You see the balance on the Overview.
5. **Add bills.** Click **Add bill**: what it is for, the payee, amount, due date, category, once, monthly or yearly, and whether it is critical. Optionally upload the invoice (PDF or photo) and Claude fills in the form for you to check. To add several at once, click **Import invoices**: drop up to 10 PDFs or photos, check the rows Claude drafts, and sign them all in one transaction. You see the bill under **Upcoming payments** as **Scheduled**; from three days before it is due, the next agent run shows it as **Paid**, **Needs approval** or **Deferred: cash buffer**.
6. **Approve.** Open **Approvals**. Each proposal shows the full payee address, the amount, the rule that sent it to you and Keel's reason; invoice text is marked unverified. Approving signs the payment with your wallet.

**Export for your accountant:** click **Export** on the Overview page (or **Export to Excel** on Activity). You get an Excel workbook, `keel-<company>-<date>.xlsx`, with five sheets:

- **Summary:** balances (vault cash, yield investment, other chains, total), counts (paid by Keel alone, approved, waiting, refused, deposits) and the rules.
- **Activity:** every decision in time order: what happened, amount, outcome, who decided (Keel alone, you or the multisig), the rule checked, Keel's explanation and a reference.
- **Payments:** the bill schedule: due date, payee, category, amount, repeat, chain, status (Paid, Needs approval, Deferred, Blocked, Overdue, Scheduled), critical, memo and the bill reference the vault pays only once.
- **Ledger:** every token movement in and out of the vault, signed, labelled from the method its transaction called (Keel's payment, your approval, a withdrawal, a deposit, the yield investment), with a link to the transaction.
- **Wallets:** the vault on NEAR (balance, buffer, above the buffer), the yield investment and its rate, and the vault's address and balance on each other chain.

The file is built in your browser from live chain data: the Ledger comes from nearblocks' public index and each transaction's details from FastNEAR's archive node. Burrow's test token (USDC.e) is not indexed there, so a USDC.e vault's Ledger is empty and the Summary says so.

## Hand a company to a multisig (optional)

1. Create the company from one member's wallet, as above.
2. Make sure that wallet is a member of the team's multisig (a Sputnik DAO, such as a Trezu treasury, for example `team.sputnikv2.testnet`).
3. Open **Rules**, enter the multisig account under **Hand ownership to a multisig** and click **Offer**. You see **Ownership offered**; nothing has changed yet.
4. Click **File acceptance on** the multisig, and have enough members approve it under **Rules**. You see **Multisig owner** with the members and the votes needed.
5. Other members open the app and connect their own wallet. You see the team's companies in the list: Keel finds every multisig that owns a Keel vault and lists their wallet as a member. Members are added and removed in the multisig itself (in Trezu, by a vote), and Keel follows. To list a team by hand, pick **Add a team's companies (multisig)** in the company card.
6. What each member can do follows their role in the multisig. Keel reads the roles: a member whose role may file proposals gets the editing controls, one whose role may vote gets **Approve** and **Reject** under **Rules**, and the Rules page shows each member's rights. Everyone, members or not, can see all of the company's data: it is on chain.
7. From then on, every owner action (limits, payees, bills, approvals, pause) files a proposal on the multisig with its bond attached (1 NEAR by default on `sputnikv2.testnet`). Members approve or reject it under **Rules**; it runs once enough have approved. Keel keeps paying inside the limits as before.

## Get testnet tokens

| What | Where |
| --- | --- |
| NEAR testnet account with free NEAR | https://near-faucet.io, or `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create` |
| USDC on NEAR testnet | https://faucet.circle.com, network "Near Testnet", sent to the vault's account |
| USDC on Base, Ethereum, Arbitrum or Optimism Sepolia | https://faucet.circle.com, picking that exact network, sent to the vault's EVM address (on the app's **Wallets** page; the same address on every chain) |
| Testnet ETH for gas on those chains | https://portal.cdp.coinbase.com/products/faucet (Base Sepolia), https://www.alchemy.com/faucets (Ethereum, Arbitrum, Optimism and Base Sepolia), https://console.optimism.io/faucet (Optimism Sepolia) |
| USDC.e, for a vault that invests at Burrow on testnet | `near contract call-function as-transaction usdc.fakes.testnet mint json-args '{"account_id":"<vault>.keel.testnet","amount":"50000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send` (50 USDC.e) |

## Hosted agent

`.github/workflows/agent.yml` runs `npm run agent -- --once` on GitHub Actions: one round over every vault on `keel.testnet`. Each vault records what it paid and proposed, so every run picks up where the last one stopped. A free external timer (cron-job.org) starts the workflow every 15 minutes through GitHub's `workflow_dispatch` API, because GitHub's own schedule fired only once in ten hours for this repository.

1. To run it now: **Actions**, **agent**, **Run workflow**. Tick **Decide but sign nothing** for a dry run.
2. To host your own copy: in **Settings**, **Secrets and variables**, **Actions**, add `KEEL_AGENT_PRIVATE_KEY` (the `private_key` from your agent key file); `ANTHROPIC_API_KEY` or `NEARAI_API_KEY` are optional. A leaked key cannot change limits, approve anything or send a yield investment anywhere but back to the vault.
3. To start it on a timer: send `POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/agent.yml/dispatches` with headers `Authorization: Bearer <token>` (a fine-grained token with **Actions: Read and write** on that repository only) and `Accept: application/vnd.github+json`, and body `{"ref":"main"}`. GitHub answers `204`.
4. To stop it: **Actions**, **agent**, **…**, **Disable workflow**, and turn off the timer.

## Repo layout and configuration

| Path | What it holds |
| --- | --- |
| `contract/` | Keel Vault smart contract and its tests |
| `factory/` | Keel factory: creates one vault per company with Keel's key on it |
| `agent/` | The agent: observe, forecast, check, decide, act, reconcile, learn, for every vault; `agent/stress/` holds the live attack suites |
| `web/` | The site and app: landing, How it works, Security and Docs pages; Overview, Approvals, Activity, Payees, Rules and Wallets (Vite, React, TypeScript, NEAR Connect) |
| `web/api/` | `read-invoice.ts`, the Vercel function that reads an uploaded invoice with Claude |
| `scripts/` | `verify.mjs` (`npm run verify`), `deploy-factory-testnet.sh`, `new-agent-key.mjs`, `rotate-agent-key.sh` and `setup-demo-testnet.sh`; see [scripts/README.md](../scripts/README.md) |
| `.github/workflows/agent.yml` | The hosted agent |
| `docs/` | This guide, how Keel works, the contract, security and what was verified |

All variables are optional; `cp .env.example .env` in the repository root to set them. The owner's private key never goes in `.env`: owner actions sign in a wallet or the NEAR CLI.

| `.env` variable | Purpose |
| --- | --- |
| `NEAR_NETWORK` | `testnet` (default) or `mainnet` |
| `FACTORY_ACCOUNT_ID` | Keel factory, `keel.testnet` on testnet |
| `AGENT_KEY_FILE` | Path to Keel's agent key file, outside the repository. Needed only to sign |
| `KEEL_AGENT_PRIVATE_KEY` | Keel's agent key itself, for hosts that keep it in a secret; used before `AGENT_KEY_FILE` |
| `NEAR_RPC_URL` | NEAR RPC; defaults to FastNEAR's public endpoint |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional Claude key and model (default `claude-haiku-5-5`) for the wording of proposal reasons |
| `NEARAI_API_KEY`, `NEARAI_MODEL` | Optional NEAR AI Cloud key and model (default `deepseek/deepseek-v3.2`) for the same wording, used first when set |
| `ONECLICK_JWT` | Optional 1Click partner token; removes the 0.2% fee |
| `EVM_RPC_<chain id>` | Optional RPC URL per EVM chain, for example `EVM_RPC_421614` for Arbitrum Sepolia |
| `DEMO_VAULT` | Vault for `npm run demo`, default `compass.keel.testnet` |

The hosted app reads one variable from its Vercel project: `ANTHROPIC_API_KEY`, for invoice reading.

## Known issues

- **Testnet only.** Every vault runs on NEAR testnet with test tokens; the contracts have not had an external audit.
- **NEAR Intents:** quotes only. No mainnet payment has been sent.
- **Other chains need funding by hand.** A vault's EVM address needs USDC and a little ETH on each chain it pays from. Keel reports what is missing but does not move USDC there from NEAR (that needs a bridge: NEAR Intents on mainnet, none on testnet). Every payment on another chain needs the owner's approval.
- **Signed means sendable.** Once the MPC network signs an approved EVM transfer, anyone can broadcast it; Keel does on its next run. Transfers land in nonce order, so one approved out of order waits.
- **Vault code is fixed at creation.** A vault keeps the contract it was created with; a company created before a feature shipped gets it by creating a new company.
- **Yield investment:** Burrow's testnet lends USDC.e, not Circle's test USDC, so only a vault holding USDC.e can invest there on testnet. The Overview's total counts the vault's cash only; the investment shows in its own card. Keel does not claim Burrow's farming rewards.
- **Agent key allowance:** 0.25 NEAR of gas per vault. NEAR checks each transaction against it at a worst-case gas price, so Keel asks for at most 200 Tgas per call. The owner renews it with `set_agent_key`.
- **Hosted agent:** a GitHub outage can skip a run (seen once as `502 Bad Gateway` from GitHub's API); the next run catches up.
- **Invoice reading** needs `ANTHROPIC_API_KEY` in Vercel. Its limit of 10 invoices per visitor per hour is kept per running server, so it is best effort.
- **Excel report:** the Ledger lists the latest 200 token transfers from nearblocks' index; tokens it does not index (Burrow's test USDC.e) leave the Ledger empty. A row whose transaction the archive node cannot return is labelled by direction only, with "Unknown" as who made it.
- **Bills are entered by the founder** (or drafted from an uploaded invoice), not imported from an accounting system or an inbox.
- **Learning is rule-based,** and the counterparty check uses on-chain signals and the vault's lists only, with no external risk scoring.
- **Multisig ownership** is optional and works with Sputnik DAO multisigs (the contracts behind Trezu) only. A company is created from one wallet and then handed over; going back needs the multisig to vote for it.
