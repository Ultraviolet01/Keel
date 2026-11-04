# Keel

Keel is an AI treasury agent that keeps a small company's stablecoin wallets funded. It can only move money inside limits enforced by a NEAR smart contract, the Keel Vault.

- **Who it is for:** a founder or lean finance lead with several wallets and chains and no treasury staff.
- **What it does:** every 15 minutes, for every company's vault, Keel reads the balance, the bills the owner listed and the approved payees, forecasts 14 days ahead and checks every payee. Then it:
  - pays bills alone when the owner's limits allow it, and proposes everything else for the owner to approve, with a plain-English reason;
  - holds back bills that are not critical when paying them would break the owner's cash buffer, and pays critical ones first;
  - keeps the company card wallet and the owner's other wallets topped up to the balances the owner set;
  - invests idle cash above the buffer for yield in the vault's own account at Burrow, NEAR's lending protocol, and withdraws it back to the vault when bills need it;
  - pays bills on Base, Ethereum, Arbitrum and Optimism from the vault's own address through NEAR Chain Signatures, after the owner approves. NEAR Intents quotes the same moves (and 38 more chains) on mainnet.
- **What the owner does:** sets limits, a cash buffer, payees and bills in the app; an invoice can be uploaded and Claude fills in the bill for the owner to check.
- **What it cannot do:** spend past a cap or below the cash buffer, pay a blocklisted address, add its own payees or bills, change its own rules, withdraw its yield investment anywhere but the vault, or move NEAR. The vault refuses those calls, whatever the agent decides.

Tracks: Autonomous Business (`business`), AI Security & Defense (`security`), Real-World Money (`realworld`).

**Just want to look?** Open https://keel-treasury.vercel.app (the landing page), then https://keel-treasury.vercel.app/app?view=keel-owner.testnet to see a founder's companies read-only with live testnet data. To act as a founder, open `/app` and connect a NEAR testnet wallet. The site is the `web/` app on Vercel; it holds no keys and every signature happens in the visitor's own wallet.

## What is real and what is a test

| Part | What was used |
| --- | --- |
| NEAR vault, factory, agent and approvals | Real transactions on **NEAR testnet**. Vaults created now, including the demo vault `beacon.keel.testnet`, hold and pay **Circle's testnet USDC on NEAR** (`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`). |
| Cross-chain payments through NEAR Chain Signatures | Real transactions on **Base, Ethereum, Arbitrum and Optimism Sepolia**, paying **Circle's test USDC** with testnet ETH for gas, signed by NEAR's testnet MPC network (`v1.signer-prod.testnet`). Links under [Live on testnet](#live-on-testnet) |
| Cross-chain payments through NEAR Intents (1Click) | **Dry quotes only**, from the live 1Click service on mainnet: real prices and routes, nothing sent. NEAR Intents has no testnet, and no mainnet payment has been made |
| Yield investment at Burrow | Real deposits and withdrawals at **Burrow's testnet lending market** (`contract.1638481328.burrow.testnet`), earning its live supply rate (about 10% a year on Nov 4). Burrow's testnet lends its own test USDC (`usdc.fakes.testnet`, shown as USDC.e), so the vault that invests there, `harvest.keel.testnet`, holds that token instead of Circle's |
| Invoice reading | Real calls to Claude from the hosted app (`/api/read-invoice` on Vercel), with Keel's own Anthropic key |
| Hosted agent | Real runs on GitHub Actions every 15 minutes, started by an external timer, signing on testnet with Keel's agent key |

Test tokens have no money value. Nothing in this repository has moved real money.

### Get testnet tokens

None of these are needed for `npm run verify` or the dry runs; they are for creating your own vault or funding a vault's EVM address.

| What | Where |
| --- | --- |
| NEAR testnet account with free NEAR | `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`, or https://near-faucet.io |
| USDC on Base, Ethereum, Arbitrum or Optimism Sepolia | https://faucet.circle.com (pick the exact network, for example "Base Sepolia", not "Ethereum Sepolia") |
| Testnet ETH for gas on those chains | https://portal.cdp.coinbase.com/products/faucet (Base Sepolia), https://www.alchemy.com/faucets (Ethereum, Arbitrum, Optimism and Base Sepolia), https://console.optimism.io/faucet (Optimism Sepolia) |
| USDC on NEAR testnet, for your own vault | https://faucet.circle.com, network "Near Testnet", sent to your vault's account (for example `acme.keel.testnet`) |
| USDC.e for a vault that invests at Burrow | Anyone can mint Burrow's test token: `near contract call-function as-transaction usdc.fakes.testnet mint json-args '{"account_id":"<vault>.keel.testnet","amount":"50000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send` (50 USDC.e) |

Send to the vault's EVM address on the **same network** you picked in the faucet: the address is the same on every chain, but the funds are not. The address is on the app's Wallets page.

## Try it in 10 minutes

Everything below runs on NEAR testnet and costs nothing. You need Node.js 22 or newer. Rust and the NEAR CLI are only needed for the contract tests and for creating your own vault.

Keel's agent signs with a key only Keel's operator holds, so from a fresh clone you run it with `--dry-run`: it reads the live vaults and shows every decision without signing. Everything Keel signed for real is linked under [Live on testnet](#live-on-testnet).

**One command for everything below:** run `git clone https://github.com/Ultraviolet01/keel && cd keel && npm run verify`. It installs what it needs and runs every check that needs no keys: typechecks, the agent and app tests, the app build, the contract tests (skipped if Rust is not installed), the demo and cross-chain dry runs against testnet, and the four recorded EVM payments, read back from each chain. You see one `PASS`, `FAIL` or `SKIP` line per check and a last line like `VERIFY PASSED: 17 passed, 0 failed, 0 skipped`; it exits 1 if anything fails. `npm run verify -- --quick` skips the contract tests and the build.

1. **Get the code.** Run `git clone https://github.com/Ultraviolet01/keel && cd keel/agent && npm install`. You see the install finish with no errors. No `.env` is needed for the steps below.
2. **Watch one full loop.** Run `npm run demo -- --dry-run`. In a few seconds you see Keel read `beacon.keel.testnet` (Circle's USDC on NEAR testnet; 5 per payment and 25 per day), forecast 14 days, check each of its six bills and decide. The hosted agent has already acted on beacon, and the vault remembers it, so on Nov 4 you see:
   - **Northwind Hosting, 4.00:** `the vault already paid this bill`. It was paid alone, because Northwind is allowlisted and 4 is inside both caps.
   - **Atlas Freight, 6.60:** `already proposed as #1, waiting for the owner`, because Atlas is not on the allowlist.
   - **"URGENT: supplier changed bank details", 47.50:** refused without signing, because the payee is blocklisted. This is the prompt-injection case: the bill's text asks for urgency and the rules ignore it. It is refused on every run.
   - **Lisbon contractor, 1.20 USDC on Arbitrum,** and **Porto designer, 0.50 USDC on Optimism:** already proposed as Chain Signatures transfers from the vault's own address (`0xf9fe…e510`, funded on both chains), waiting for the owner. NEAR Intents is skipped because it runs on mainnet only.
   - **Contractor payroll, 12.50:** proposed, because the vault holds 7 and it is over the 5 per-payment cap.

   On a fresh vault the same command shows `pay` and `propose` instead of "already paid" and "already proposed": the vault pays each bill once.
3. **Watch a bill on Base.** Run `npm run agent -- --once --dry-run --vault vega.keel.testnet`. You see Keel skip NEAR Intents 1Click (mainnet only), fall back to NEAR Chain Signatures, and decide to propose paying 3 USDC from the vault's own Base Sepolia address. You also see two earlier Base transfers reported as already paid.
4. **Run the tests.** In `agent/`, run `npm test`: 30 tests pass, including about 37,000 generated cases. With Rust installed, run `cargo test` in `contract/` (114 tests) and in `factory/` (17 tests).
5. **Open the app.** Run `cd ../web && npm install && npm run dev` and open the address it prints, then `/app?view=keel-owner.testnet`. You see that founder's companies read-only with live testnet data: switch to `beacon`, `anchor` or `nova` in the company card, and open Approvals to see Keel's proposals and reasons. Details are in [web/README.md](web/README.md).
6. **Create your own company (optional).** In the app, click **Open app**, connect a testnet wallet holding about 4 NEAR, name your company and click **Create vault**. Or from the command line: `near contract call-function as-transaction keel.testnet create_vault json-args '{"name":"<company>"}' prepaid-gas '300 Tgas' attached-deposit '3.9 NEAR' sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send`. You see `"<company>.keel.testnet"` returned: your own vault, owned by you, with Keel's agent key already on it and no limits, so every payment needs your approval. The deposit is `min_vault_deposit` from `get_config` on `keel.testnet` (3.86 NEAR now); it pays the vault's storage and stays in the vault.
7. **Set your limits (optional).** In the app, click **Set limits**. Or call `update_policy` with 1 yoctoNEAR attached: `near contract call-function as-transaction <company>.keel.testnet update_policy json-args '{"update":{"per_payment_cap":"100000000","daily_cap":"500000000","allow":["<payee>.testnet"]},"reason":"initial policy"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send`. You see `get_policy` return your values. Add `"min_balance":"<amount>"` to set a cash buffer: Keel then never pays if the vault would hold less. Pause, resume, approve and reject work the same way, from the sidebar and the Approvals page.
8. **Approve your payees (optional).** In the app, open **Payees** and click **Approve a payee**: a name, the kind (vendor, employee, company card wallet, bank off-ramp, your own wallet, yield destination) and the NEAR account. For a card or your own wallet you can set a balance to keep. For a yield destination you set the most Keel may move at once, and can tick **lending market** to use Burrow; it needs a cash buffer. You see it listed as **Approved by you**, and it is on the vault's allowlist. Command line: `add_payee` with `{"payee":{"account_id":"card.<you>.testnet","name":"Company card","kind":"card","keep_at":"300000000"}}` and 1 yoctoNEAR.
9. **Add your bills (optional).** In the app, click **Add bill** on the Overview page. Optionally upload the invoice (PDF or photo): Claude fills in vendor, amount, due date, invoice number and category, and you check them before signing. Pick the payee (a NEAR account, or a 0x address on Base, Ethereum, Arbitrum or Optimism), the category, whether it repeats (once, monthly, yearly), and whether it is **critical** (paid first, never held back for the buffer). Or call `add_bill` with 1 yoctoNEAR attached: `near contract call-function as-transaction <company>.keel.testnet add_bill json-args '{"bill":{"id":"hosting-nov","payee":"<payee>.testnet","amount":"4000000","due":"2026-11-30","monthly":false,"yearly":false,"category":"hosting","chain":null,"label":"Hosting"}}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send`. You see the bill under **Upcoming payments** as **Scheduled**. From three days before it is due, the hosted agent's next run (every 15 minutes) pays it if the payee is allowlisted and the amount is within your caps, and it shows **Paid**; otherwise Keel proposes it and it shows **Needs approval**. If paying it would break your cash buffer, it shows **Deferred: cash buffer** until it is due. Deposit USDC first, or Keel proposes the bill because the vault holds less.

**Export for your accountant:** click **Export** on the Overview page, or **Export CSV** on the Activity page. You get a CSV with one row per proposal: id, time (UTC), receiver, amount, token, status and reason.

## How it works

```mermaid
flowchart LR
  S["1. Setup<br/>owner deploys vault"] --> O["2. Observe<br/>ft_balance_of, bills"]
  O --> F["3. Forecast<br/>14 days, buffer"] --> D["4. Decide<br/>pay, defer, top up, invest, withdraw"] --> C["5. Check<br/>check_payment view"]
  C -- within limits --> A["6. Act<br/>vault, Burrow, Chain Signatures"]
  C -- outside limits --> E["9. Escalate<br/>propose, owner approves"]
  E -- approved --> A
  A --> R["7. Reconcile<br/>receipts, ledger page"] --> L["8. Learn<br/>memory, rule drafts"] --> O
  L -. rule draft .-> E
  E -. owner-approved rule update .-> S
```

A move within limits goes straight from Check to Act; anything over the threshold becomes a proposal. Blocked moves stop at Check and are logged, never proposed. The hosted agent runs stages 2 to 8 every 15 minutes (see [Hosted agent](#hosted-agent)); run locally, `npm run agent` repeats them every 5 minutes (`--interval` changes it). Deciding is plain code; Claude only writes the wording of a proposal's reason and reads uploaded invoices.

## Keel Vault contract

The vault holds the USDC and the rules, and decides every payment's band itself. It deploys with no policy; the owner chooses every limit. The agent's key can call only three methods: two to pay or propose, and one that withdraws the vault's yield investment from its lending market back into the vault.

| Method | Who can call it | What it does |
| --- | --- | --- |
| `execute_payment` | Agent key | Pays an allowlisted payee if the amount is within the per-payment and daily caps, and the bill (`bill_ref`) was not paid before |
| `propose_payment` | Agent key | Files a proposal for anything over the threshold, a new payee or a cross-chain move, optionally with an expiry (`valid_until_ms`) or a Base transfer (`evm`). A newer proposal for the same bill replaces the waiting one |
| `bill_paid_at` | Anyone (view) | When the vault paid a bill, or `null` |
| `pending_count` | Anyone (view) | How many proposals wait for the owner; at most 50 |
| `add_bill` / `cancel_bill` | Owner key | Lists a bill for Keel to pay (payee, amount, due date, category, once, monthly or yearly, optionally on another chain), or stops watching it. At most 50; the agent cannot add one |
| `get_bills` | Anyone (view) | The bills the owner listed |
| `add_payee` / `remove_payee` | Owner key | Approves a payee with a name and kind (adds it to the allowlist), optionally with a balance Keel keeps topped up for a card or own wallet; or removes it |
| `get_payees` | Anyone (view) | The payees the owner named |
| `add_payee` with kind `yield` | Owner key | Approves a yield destination with `max_move`; Keel may move idle cash there only within that limit and only with a cash buffer set |
| `recall_from_yield` | Agent key or owner key | Withdraws from an approved lending market (Burrow) back into the vault, and nowhere else; works while paused |
| `on_balance_checked` | Vault only (callback) | With a cash buffer set, pays an agent payment only if the vault still holds the buffer afterwards |
| `on_payment_done` / `on_deposit_done` / `on_recall_done` / `on_evm_signed` | Vault only (callbacks) | Record each payment, Burrow deposit, Burrow withdrawal and MPC signature, and undo the bill mark and today's spend when something did not happen |
| `release_bill` | Owner key | Lets a bill be paid again, after the owner confirms a payment never arrived |
| `check_payment` | Anyone (view) | Returns the band a payment would land in, without moving money |
| `approve` / `reject` | Owner key | Executes or closes a proposal |
| `update_policy` | Owner key | Changes caps, the cash buffer (`min_balance`), allowlist or blocklist, and logs old value, new value and reason |
| `get_policy` / `get_proposals` / `get_proposal` | Anyone (view) | The rules, today's spend and the proposals |
| `pause` / `resume` | Owner key | Stops every payment at once, then restarts them |
| `withdraw` | Owner key | Pays out directly, for example back to the owner; works while paused |
| `revoke_agent` / `set_agent_key` | Owner key | Fires the agent by deleting its key from the vault, or adds a new one |
| `set_evm_route` / `withdraw_evm` | Owner key | Sets or turns off one EVM chain's token, decimals and fee caps for Chain Signatures payments; moves funds out of the vault's EVM address |
| `get_evm_route` | Anyone (view) | The vault's EVM routes and the inputs that derive its EVM address (the same on every chain) |

| Band | Rule (USDC) | Result |
| --- | --- | --- |
| Runs alone | Allowlisted payee, within the owner's per-payment and daily caps (example: 100 and 500) | Vault pays, Keel logs and reconciles |
| Needs approval | Over 100, a new payee, or any cross-chain swap | Proposal waits for the owner |
| Blocked | Blocklisted payee, vault paused, daily cap reached, or (for the agent) the payment would break the cash buffer | Vault refuses; Keel logs it, and holds back or proposes the bill |

Token details the vault handles itself: it attaches the 1 yoctoNEAR that `ft_transfer` requires, because a function-call key cannot attach a deposit; it registers new payees with `storage_deposit` before paying them; and it deposits into a lending market with `ft_transfer_call`, registering with the market once (0.1 NEAR of storage), so the deposit is credited to the vault's own account there.

Owner methods require exactly 1 yoctoNEAR attached. Function-call keys cannot attach a deposit, so only the owner's full-access key can approve, change the policy or pause.

**Check the rules yourself:** run `cd contract && cargo test`. You see 114 tests pass, one per rule, including `refuses_payment_over_cap`, `refuses_blocklisted_payee`, `agent_cannot_change_policy`, `revoked_agent_can_do_nothing`, `pause_blocks_everything_until_resume`, `evm_bill_with_a_huge_fee_is_refused`, `signing_hash_matches_an_independent_encoder`, `agent_cannot_pay_the_same_bill_twice`, `a_failed_transfer_frees_the_bill_to_be_paid_again`, `at_most_50_proposals_wait_at_once`, `owner_can_still_act_when_the_vault_is_low_on_near` and `an_18_decimal_token_gets_the_amount_scaled`. Method details are in [contract/README.md](contract/README.md). For the factory, run `cd factory && cargo test`: 17 tests.

## Security

**Each bill is paid once, enforced by the vault.** Keel tags every payment and proposal with the bill's id. The vault records each bill it pays and refuses a second payment (`Keel Vault refused: this bill was already paid`), even if the agent restarts with no memory or is tricked into retrying. A failed transfer frees the bill again. At startup Keel reads `bill_paid_at` and the vault's proposals, so a lost `agent/state.json` never causes a double payment.

1. Run `cd agent && rm -f state.json && npm run agent -- --once --dry-run --vault orbit.keel.testnet`. With no memory at all, you see `the vault already paid this bill` for Northwind and `already proposed as #1` for Atlas.

The agent never holds a key that can move money freely. Limits live in the contract, so a compromised or prompt-injected agent still cannot overspend.

- **Cash buffer, enforced by the vault:** the owner sets `min_balance` with `update_policy`. With a buffer set, `execute_payment` first asks the token contract for the vault's balance and pays from the callback only if the vault still holds the buffer after this payment and every other agent payment in flight; otherwise it undoes the daily spend and the bill mark and emits `payment_refused`. The owner's own `withdraw` and approvals ignore the buffer. On testnet, forcing a 2 USDC payment through `ballast.keel.testnet` with the agent key (4 USDC held, 3 USDC buffer) was refused on chain ([transaction](https://testnet.nearblocks.io/txns/5cCb98Z2dAe15u9WVMo8gL82YLwJNzzyU4a7bKkpdDCx)); 1 USDC, leaving exactly 3, went through ([transaction](https://testnet.nearblocks.io/txns/3EuBM5Yo2SBLTqeuxFSgLZ81yAF6Qt6svfEieAsbeoKQ)).
- **Yield investments only come back to the vault:** `recall_from_yield` withdraws only from a lending market the owner approved, and Burrow pays withdrawals only to the account that deposited, the vault itself. A Burrow deposit is refused above the destination's `max_move`, and without a cash buffer. On testnet the agent key withdrew 5 USDC.e home from Burrow ([transaction](https://testnet.nearblocks.io/txns/izdqBBaYAGE325ZmgsXdMw26VeoBPM7k5WhnroBYHrd)).
- **Only the owner lists bills:** `add_bill` and `cancel_bill` need the owner's full-access key (1 yoctoNEAR attached), so a phished invoice or a compromised agent cannot add work for Keel. A listed bill gets no special treatment: it goes through the same bands as any payment (test `a_listed_bill_still_goes_through_the_bands`).
- **Agent key on the vault, added at sign-up:** the factory adds Keel's agent key to each new vault account in the same transaction that creates it. It is a NEAR function-call access key limited to that vault's `execute_payment`, `propose_payment` and `recall_from_yield` (vaults created before Nov 4 have only the first two), with a 0.25 NEAR gas allowance. `recall_from_yield` can only withdraw from an approved lending market back into the vault. It cannot transfer NEAR, add keys, call `update_policy` or touch any other vault. The vault also checks that the agent key signed the call.
- **No other keys:** the vault account has no full-access key, so nobody, Keel included, can sign as the vault to move money around its rules.
- **The founder can fire the agent:** `revoke_agent` deletes the key from the vault in one transaction; `set_agent_key` adds a new one. Both need the owner's full-access key.
- **Owner key:** the founder's own wallet. Keel never holds it, and it is never stored in this repository.
- **Gas:** the agent's gas comes from the vault's own deposit, not from Keel.
- **Rule changes:** every `update_policy` call emits a `policy_updated` event with old value, new value, reason and approver, readable by anyone on chain.

**Counterparty check:** before any payment, Keel scores the receiver and returns a verdict with its reasons.

| Verdict | What Keel does |
| --- | --- |
| Allow | Continues to the vault's own band check |
| Warn | Never pays alone; files a proposal with the reasons for the owner |
| Block | Refuses to sign and logs the reasons |

| Signal | Source | Verdict |
| --- | --- | --- |
| Blocklisted | Vault blocklist, set by the owner | Block |
| Account does not exist | `view_account` | Block |
| Contract whose code changed since Keel last saw it | `view_account` code hash, compared with the last one Keel saw | Warn |
| Not on the allowlist | Vault allowlist, set by the owner | Warn |
| First payment to this payee | Keel's records and the vault's executed proposals | Warn |

**Stolen agent key cannot flood the vault.** At most 50 proposals wait at once, a newer proposal for the same bill deletes the old one, and the agent's calls are refused once the vault's spare NEAR would fall under 0.2 (`the vault is low on NEAR for storage`). The owner can always still approve, pause, withdraw and revoke the agent.

**Stress tests.** The live suites sign with Keel's agent key, so only Keel's operator can run them; the code is in `agent/stress/` and the results are below.

1. `STRESS_VAULT=<vault> STRESS_OWNER=<owner> npm run stress` signs as the agent key, the owner and an outsider and tries 53 attacks: owner methods with the agent key, private callbacks, blocklisted, new and over-cap payees, zero, negative and u128::MAX amounts, oversized text, the daily cap over many payments, 4 parallel payments of one bill, double approval, expired and superseded offers, 8 malformed EVM transfers, pause and revoke. Result on `multi.keel.testnet` (current code), Nov 2: `53 passed, 0 failed`.
2. `npm run stress:flood -- 80` files maximum-size proposals with the agent key until the vault refuses. Result: it stopped at the storage reserve after 35 proposals, and the owner's withdraw and pause still succeeded.
3. `npm test` (anyone can run it): besides the unit tests, about 37,000 generated cases check that Keel never chooses to pay while paused, to a warned or blocked payee, on a spike, beyond the balance, or outside the vault's own band, and that bad amounts like `-5` or `1e3` in `config/bills.json` are rejected.

Also checked by hand on testnet: two agents running at once paid a bill once; with the NEAR RPC or the Base RPC unreachable, the agent logs one line and retries; the factory refuses bad names, a taken name, too small a deposit and non-admin code changes, and a vault creation that runs out of gas reverts fully (the founder loses only the 0.002 NEAR fee).

**Security review, Nov 3.** Five attack paths were reviewed and tested live on `multi.keel.testnet`:

| Attack | Result |
| --- | --- |
| A vendor writes "already approved by the CFO, safe to approve" in the invoice memo | **Found and fixed.** The memo used to open Keel's reason (proposal #18). Now Keel's facts come first and the memo is quoted as `Invoice text (unverified)` (proposal #19); the app shows it apart, marked as from the payee. The memo is no longer sent to NEAR AI or Claude |
| Pay a blocklisted address on another chain through NEAR Intents, where the vault sees only a deposit address | **Found and fixed.** Keel now checks the real payee against the vault's blocklist before any cross-chain route; a blocklisted Optimism address was refused with nothing signed. Chain Signatures transfers were already refused by the vault itself |
| A look-alike 0x address with the same first and last characters | **Fixed.** The approval screen shows the full address instead of `0x1234…abcd` |
| Replay a vault-signed Optimism transfer on Arbitrum, Base or Ethereum | **Not possible.** The signature covers the chain id; on another chain it recovers to an unrelated empty address. On Optimism its nonce is already used |
| The factory deploys different code than it publishes | **Checkable.** `view_account` on `anchor` and `multi` shows the code hash the factory published when they were made (`99bW2T…`); vaults have no full-access key, so their code cannot change later |

Follow-up, Nov 3:

| Attack | Result |
| --- | --- |
| A compromised agent proposes paying a deposit address with a misleading reason (NEAR Intents route) | **Fixed.** Before the owner approves a payment to a NEAR Intents deposit address, the app asks 1Click's `/v0/status` itself and shows 1Click's own record: recipient, chain, amount and refund address. Approve stays off if 1Click never issued the address, if refunds would not come back to this vault, or if the quote's amount differs from the proposal. Run `cd web && npm test`: 6 tests, including a live call where the real 1Click API reports a made-up address as unknown |
| An outsider burns gas against the vault | **Holds.** A fresh faucet account (`griefer-keel.testnet`) sent 10 calls at 300 Tgas each (`execute_payment`, `propose_payment`, `approve`, and both private callbacks). All 10 were refused; the attacker paid 0.0016 NEAR, and the vault's NEAR, storage and the agent key's allowance did not change |
| Someone registers a look-alike vault name first | **Visible.** Names are first come, first served on NEAR and cannot be reserved, but a name never grants ownership. When a founder picks a name someone already chose, the app says so, suggests free ones, and handles the rare case where the name is taken between the check and the click without spending the deposit. The app shows each vault's owner, warns when a signed-in founder opens a vault they do not own, and warns if the vault's owner differs from the factory's record. All vaults on `keel.testnet` matched on Nov 3 |

**Prompt-injection demo:** the "URGENT: supplier changed bank details" bill in step 2 of Try it is refused by Keel's own check before anything is signed. When the same payment is forced through the agent key anyway, the vault refuses it on chain (`Keel Vault refused: payee is on the blocklist`, one of the checks in `npm run stress`).

## Live on testnet

Deployed on Nov 2, 2026 with `scripts/deploy-factory-testnet.sh`. Anyone can read these, for example `near contract call-function as-read-only keel.testnet get_config json-args {} network-config testnet now`.

| Account | What it is |
| --- | --- |
| `keel.testnet` | Keel factory: creates a vault for each company a founder adds (up to 20 per founder) |
| `nova.keel.testnet` | The first company vault owned by `keel-owner.testnet`, with Keel's agent key `ed25519:GZ1zQGxc…` added by the factory at sign-up; used for the first live demo |
| `kora.keel.testnet`, `lumen.keel.testnet` | Earlier vaults for the same founder, from before the agent key moved onto the vault; they use the separate agent account `agent.keel.testnet` |
| `beacon.keel.testnet` | The demo vault for `npm run demo`, owned by `keel-owner.testnet`, holding Circle's USDC on NEAR testnet. Its address on every EVM chain is `0xf9fe3056ffc0f2e04f8a18bdcb877e979b5ce510` |
| `anchor.keel.testnet` | The previous demo vault (Keel Test USDC), whose own EVM address `0x3d003b3d8da32261fbba854dc16188cd02436644` made the four Sepolia payments below |
| `multi.keel.testnet` | Test vault for the multi-chain signing check and the attack suite, owned by `vega-founder.testnet` |
| `harbor.keel.testnet` | An earlier demo vault with only the Base route |
| `orbit.keel.testnet` | The earlier demo vault, used for the memory-loss test below |
| `vega.keel.testnet` | A vault created with the Chain Signatures code, owned by `vega-founder.testnet`. Its Base Sepolia address is `0x69aa0eb2153c0fed2cd3b44f418f50a02a3cffed` |
| `keystone`, `meridian`, `ballast`, `tideline` `.keel.testnet` | Vaults made while adding owner-listed bills, named payees and card top-ups, the cash buffer and critical bills, and yield destinations; see [Treasury decisions](#treasury-decisions) |
| `harvest.keel.testnet` | The vault with a yield investment at Burrow: holds USDC.e, a 10 USDC.e cash buffer, and Burrow approved as its lending market |
| `contract.1638481328.burrow.testnet` | Burrow's lending market on testnet (not Keel's) |
| `usdc.keel-owner.testnet` | Keel Test USDC, used by vaults created before Nov 3 |
| `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` | Circle's USDC on NEAR testnet, used by vaults created now (`set_token` on the factory) |

Checked live:

1. **Founder signs up, agent connected automatically.** `keel-owner.testnet` called `create_vault` with `"nova"` ([transaction](https://explorer.testnet.near.org/transactions/7uK1gfQUHUbyL8e3n7KWojtNdTmpgxAQtWdMGzhV2ETw)). With no script run, `near account list-keys nova.keel.testnet network-config testnet now` shows one key: `only do ["execute_payment", "propose_payment"] function calls on nova.keel.testnet with an allowance of 0.25 NEAR`.
2. **The agent works inside the rules.** Signing with that key, the agent's payment is refused (`Keel Vault refused: new payee, not on the allowlist`), its proposal is accepted as `1`, and its `update_policy` call is rejected by the network (`isn't allowed by the access key`).
3. **The founder fires and rehires the agent.** `revoke_agent` deleted the key ([transaction](https://explorer.testnet.near.org/transactions/2pFH9SePN6REQ172fZbzRFcsiB1tvp5rFagV9PigENC5)) and the agent's next call failed with `Access key ... does not exist`. `set_agent_key` added it back ([transaction](https://explorer.testnet.near.org/transactions/3XJqZ1wSxaxEMn5dd1mvfNYTmMT83uefCfvBzM2K6Vhy)) and the agent's next proposal was accepted as `2`.
4. **Earlier sign-up.** `keel-owner.testnet` called `create_vault` with `"kora"`. You see `"kora.keel.testnet"` returned and a `vault_created` event ([transaction](https://explorer.testnet.near.org/transactions/GLV4QR6FwuZeTSPWWHrEvZxdsFky4dGVTNKx5H69W4Fy)).
5. **One founder, several companies.** The same founder added `"lumen"` ([transaction](https://explorer.testnet.near.org/transactions/QX7P8RhhbXG1AbMo87KQNvE2hn6QUEGqRhen6L6bud2)). You see `get_vaults_for_owner` on `keel.testnet` return all three: `kora`, `lumen` and `nova`. Each vault has its own money, policy and agent key.
6. **Same code everywhere.** `get_config` on `keel.testnet` shows `vault_code_hash` `CtzDuiAmgqmfozUUbxYCfSTHQWjmhekmd1Qhj4jK8Kmb`, the base58 SHA-256 of `contract/target/near/keel_vault.wasm` built from this repository at this commit.
7. **The agent runs the demo.** After `scripts/setup-demo-testnet.sh` (Nova's policy: 100 per payment, 500 per day, Northwind and Payroll allowed, the scam account blocked; 1,000 test USDC), `npm run demo` took 9.6 s: it paid Northwind Hosting 80 alone ([transaction](https://testnet.nearblocks.io/txns/Da5R9fRbMDYnRoVeyadGMD4ikgFUY8fQZir93Lb6ZQyS)), proposed Atlas Freight 132 as #3 because Atlas is not allowlisted ([transaction](https://testnet.nearblocks.io/txns/7vdd1dT2t3cWxUUBxSPCyG74aHwt9Q6LVp7NGupWVs2f)), refused the "URGENT: supplier changed bank details" bill without signing because the payee is blocklisted, and proposed Contractor payroll 450 as #4 because it is over the cap ([transaction](https://testnet.nearblocks.io/txns/5pi9j2RtGvjn2vcUx712ytgJGkrSZyRRKeHCfosCpCS2)). `ft_balance_of` shows `northwind-keel.testnet` holding 80 and the vault 920.
8. **Paying on Base without 1Click.** The agent proposed a 1 USDC transfer on Base Sepolia from `vega.keel.testnet` as #1 ([transaction](https://testnet.nearblocks.io/txns/FjjJnVwJfmc7GmDvPXxEToZqJNj3zf4NhMXcw96Ug7ue)). The founder approved it ([transaction](https://testnet.nearblocks.io/txns/CwtmxfryUoEoCwKUAUHETVx6fKmYkU3fNZHzsUDxM2Bp)). The vault built the transfer, `v1.signer-prod.testnet` signed it, and the vault stored it with an `evm_signed` event. Recovering the signer from the stored transaction with viem gives `0x69aa…cffed`, the vault's own address. Once the address was funded, Keel broadcast it and it landed on Base Sepolia ([transaction](https://sepolia.basescan.org/tx/0x810f796b040edca5df3b1c3c3097d2dc31f5f060bf06e5436166b300f3b29171)).
9. **A Base bill paid end to end.** For a 15 USDC "Designer invoice, paid in USDC on Base" bill, Keel skipped 1Click (mainnet only), proposed a Chain Signatures transfer as #4, the founder approved it ([transaction](https://testnet.nearblocks.io/txns/EyRxbDQyv4MocVD1DwhWkrgMZuWufrbRJFRxXjmHMK1V)), and Keel broadcast the vault-signed transfer ([transaction](https://sepolia.basescan.org/tx/0xb39efe2b80d77ced7be0bb619055c957b4271fbf490cc7a8bdd1a894a64aa1d3)). The vault's Base address went from 20 to 4 USDC. An earlier proposal, #3, had taken a nonce that #1 then used; Keel flagged it as unable to land and proposed #4 instead.
10. **No double payment after memory loss.** On `orbit.keel.testnet`, `npm run demo` paid Northwind 80 ([transaction](https://testnet.nearblocks.io/txns/3vcwJbZebqFq8DueC2HP1W5qsrdFwt8NgbDm5tRAD7B9)) and proposed Atlas (#1) and payroll (#2). After deleting `agent/state.json`, the next run reported Northwind paid and Atlas proposed, and signed nothing. Calling `execute_payment` for the same bill directly with the agent key failed on chain with `Keel Vault refused: this bill was already paid`; the vault's balance stayed at 920.
11. **One address, several chains.** On `multi.keel.testnet` the agent proposed a 1 USDC transfer on Arbitrum Sepolia and one on Ethereum Sepolia, and the owner approved both. `v1.signer-prod.testnet` signed each: the stored transactions carry chain ids 421614 and 11155111, each chain's Circle USDC contract and a `transfer` of 1,000,000 units, and both recover to the vault's own address `0x1cd65ce3344a4e6ecc53af2d46b482ac714b8418`.
12. **Optimism.** The owner added the Optimism Sepolia route to `multi` and `anchor` with `set_evm_route` (no new vault needed). `v1.signer-prod.testnet` signed a 1 USDC `transfer` for chain 11155420 with Optimism's Circle USDC contract, recovering to the same vault address.
13. **A real payment on Optimism.** With 20 USDC and 0.025 ETH on `anchor`'s Optimism Sepolia address, Keel skipped 1Click (mainnet only), proposed a 10 USDC Chain Signatures transfer as #1 ([transaction](https://testnet.nearblocks.io/txns/vJz5TU4eTa6zYLZC8FH1CQh6iEnpD5AfMKUk3oZ8JBX)), the owner approved it and the vault stored the MPC signature ([transaction](https://testnet.nearblocks.io/txns/2Rb8SPw1cHwCdnAehxd22Hwz68zx9MGULhJnC6RWHv6U)), and Keel broadcast it ([transaction](https://sepolia-optimism.etherscan.io/tx/0xdb1cead324fe94772a9c666de29eb1a446de5de2cef38145844637d28d0bae13)). The receipt shows a 10 USDC `Transfer` from the vault's own address; the address went from 20 to 10 USDC and spent 44,843 gas.
14. **Full run, Nov 3: NEAR plus four EVM testnets, all paid.** On `multi.keel.testnet`, Keel paid Northwind 80 alone ([transaction](https://testnet.nearblocks.io/txns/73Sc4yFKA1AUtL7csQP4hicE4yauMq8ZWV4MDSQdmepM)), proposed Atlas 132 as #16 (new payee), refused the scam bill without signing, and proposed payroll 450 as #17 because the vault held only 447 after Northwind; the owner approved #16 and Atlas received 132 ([transaction](https://testnet.nearblocks.io/txns/HfXRAvR5hpP5p6WcyhUUSqbZgs2YuWLPXdXkhcM3bGT5)). On `anchor.keel.testnet`, a 1 USDC bill on each EVM testnet gave:
    - **Optimism Sepolia:** proposed, approved, signed by the MPC network and paid ([transaction](https://sepolia-optimism.etherscan.io/tx/0xa7312eb69bde5c12aade691af65f96e293fa291a0c3524eb2cd2b272f33b468f)).
    - **Arbitrum Sepolia:** proposed, approved, signed and paid ([transaction](https://sepolia.arbiscan.io/tx/0x4864319fc6f117023ba00a343641c6f2eae02e573ef756dca5aa2ca16d9417d2)).
    - **Base Sepolia:** first not proposed; Keel reported `has no ETH for gas` (the address held USDC but no ETH). Once ETH arrived, the next run proposed it as #4, the owner approved, and it paid ([transaction](https://sepolia.basescan.org/tx/0x4df6011a6fcc8f5896c29f5cb3e773d5f8cfcda6effc02d893c051123b3fd674)).
    - **Ethereum Sepolia:** first not proposed; Keel reported `holds 0 USDC, needs 1 USDC; top it up` (the address held ETH but no USDC). Once USDC arrived, Keel proposed it as #5, the owner approved, and it paid ([transaction](https://sepolia.etherscan.io/tx/0x044b25a1517da47944215cf34177ed7c3b746a7db783799c0e9f15598c63d66e); 53,643 gas).

    All four receipts show a 1 USDC `Transfer` from the vault's own address `0x3d003b3d8da32261fbba854dc16188cd02436644`: one address, paying on four chains.

## Cross-chain bills

A bill with `"chain"` set (and optionally `"token"`, for example `"USDT"`) is paid on that chain. Keel has two independent routes, so one service going down does not stop the bill:

| Route | Chains | Depends on | Testnet |
| --- | --- | --- | --- |
| 1. NEAR Intents 1Click | 38 chains, 210 tokens on Nov 2: Ethereum, Arbitrum, Optimism, Base, Polygon, Avalanche, Solana, Tron, TON, Sui, Aptos and more; can swap to the token the payee wants | Defuse's 1Click API | No, mainnet only |
| 2. NEAR Chain Signatures | Base, Ethereum, Arbitrum and Optimism, on mainnet and on their Sepolia testnets. USDC only | NEAR validators only (MPC network) | Yes |

Keel tries 1Click first and falls back to Chain Signatures. If neither works, the bill waits and Keel tries again on the next run. Details and a dry run are in [agent/README.md](agent/README.md#cross-chain-bills-two-routes).

**Chain Signatures route.** Each vault controls one EVM address, the same on every chain, derived from its own account by NEAR's MPC contract. The vault signs only one thing: a USDC `transfer` on one of the owner's chains, with gas and fees under that chain's caps (100,000 gas; 5 gwei on Base, Arbitrum and Optimism, 50 gwei on Ethereum). It converts amounts to each token's decimals, so the owner can also add a chain whose stablecoin uses 18. It builds and hashes the transaction itself, so the agent cannot get anything else signed. Signing waits for the owner's approval, and blocklisted 0x addresses are refused. Approving needs 300 Tgas, because the vault waits for the MPC signature.

### NEAR Intents leg (quotes live, no mainnet move yet)

NEAR Intents has no testnet, so this route has only been quoted, not used to move money. The code path is complete and tested; a real payment would need a mainnet vault and real USDC, which this submission does not use. 1Click was down (HTTP 521) for part of Nov 2, which is why Keel falls back to Chain Signatures.

1. **List tokens.** Run `cd agent && npm run intents -- tokens USDC`. You see USDC on each chain 1Click supports (`near`, `eth`, `arb`, `base`, `sol` and more) with its asset id.
2. **Dry quote.** Run `npm run intents -- quote --to base --amount 5`. You see the expected output and time with nothing sent, for example `5.0 USDC on near -> 4.996979 USDC on base`, about 22 s after the deposit confirms (Nov 2).
3. **Propose.** For a bill, Keel asks for an exact-output quote, so the payee receives the whole invoice and the fee comes from the vault. It refuses a quote that costs more than 3% over the bill's value, using 1Click's own USD prices. Dry quotes for a 100-unit bill on Nov 2: USDC on Ethereum cost 101.33 USDC (about 27 s), USDC on Arbitrum 101.03 (about 19 s), USDT on Ethereum 101.20; these include a 1% slippage allowance that 1Click refunds if unused.
4. **Approve.** Keel proposes paying the quote's deposit address, with `valid_until_ms` two minutes before the quote's deadline. The vault refuses to approve it after that time, so funds never go to an inactive address.
5. **Follow it.** After the owner approves and the vault pays, Keel polls `/v0/status` until `SUCCESS`, `REFUNDED` or `FAILED`.

**Fees:** requests without a partner JWT pay an extra 0.2%. Set `ONECLICK_JWT` in `.env` to remove it.

## NEAR tools used

- NEAR smart contract (Keel Vault)
- Function-call access keys (scoped agent key)
- NEAR Intents 1Click API (cross-chain moves)
- NEAR Chain Signatures (each vault's own address on Base, Ethereum, Arbitrum and Optimism, the fallback route when 1Click is down)
- Burrow, NEAR's lending protocol (where idle cash earns, in the vault's own account)
- NEAR AI Cloud (optional, writes the wording of a proposal's reason; decisions stay in plain code). Claude can write it instead with `ANTHROPIC_API_KEY`, and reads uploaded invoices in the app

## Repo layout and configuration

| Path | What it holds |
| --- | --- |
| `contract/` | Keel Vault smart contract and its tests |
| `factory/` | Keel factory: one vault per company, created when a founder signs up or adds a company |
| `agent/` | The agent service: observe, forecast, check, decide, act, reconcile, learn, for every vault on the factory; `agent/stress/` holds the live attack suites |
| `config/bills.json` | Bills for vaults created before `add_bill` (the demo vaults). Newer vaults list theirs on chain. Keel watches (due dates can be relative, like `+2`; `"chain": "base"`, `"eth"`, `"arb"` or `"op"` and optionally `"token"` for other chains) |
| `package.json`, `scripts/verify.mjs` | `npm run verify`: every keyless check with one pass/fail summary |
| `scripts/` | `deploy-factory-testnet.sh`, `new-agent-key.mjs` (Keel's agent keypair), `rotate-agent-key.sh` (switch an owner's vaults to a new agent key) and `setup-demo-testnet.sh` (demo payees, policy and test USDC for one vault) |
| `web/` | The app: landing page, How it works, Security and Docs pages, wallet sign-in, one vault per company, Overview, Approvals, Activity, Payees, Rules and Wallets (Vite, React, TypeScript, NEAR Connect) |
| `web/api/` | `read-invoice.ts`, the Vercel function that sends an uploaded invoice to Claude and returns a draft bill |
| `.github/workflows/agent.yml` | The hosted agent: one round over every vault, on a schedule or when started |
| `design/` | HTML mockups and screenshots of the screens |
| `test-token/` | Keel Test USDC, a NEP-141 token with 6 decimals for testnet only |

All variables are optional; `cp .env.example .env` in the repository root to set them. The agent reads `.env` from there.

| `.env` variable | Purpose |
| --- | --- |
| `NEAR_NETWORK` | `testnet` (default) or `mainnet` |
| `FACTORY_ACCOUNT_ID` | Keel factory, `keel.testnet` on testnet |
| `AGENT_KEY_FILE` | Path to Keel's agent key file from `scripts/new-agent-key.mjs`, outside the repository. Needed only to sign |
| `NEAR_RPC_URL` | NEAR RPC; defaults to FastNEAR's public endpoint |
| `KEEL_AGENT_PRIVATE_KEY` | Keel's agent key itself (`ed25519:…`), for hosts that keep it in a secret instead of a file, like GitHub Actions. Used before `AGENT_KEY_FILE` |
| `NEARAI_API_KEY`, `NEARAI_MODEL` | Optional NEAR AI Cloud key and model for the wording of proposal reasons |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional Claude key and model (default `claude-haiku-5-5`) for the same wording, used when `NEARAI_API_KEY` is empty. The bill's invoice text is never sent to either model |
| `ONECLICK_JWT` | Optional 1Click partner token; removes the 0.2% fee |
| `EVM_RPC_<chain id>` | Optional RPC URL per EVM chain, for example `EVM_RPC_421614` for Arbitrum Sepolia; defaults are public endpoints |
| `DEMO_VAULT` | Vault for `npm run demo`, default `beacon.keel.testnet` |

The owner's private key is never put in `.env`. Owner actions sign through the NEAR CLI or a wallet.

## Treasury decisions

| Decision | What Keel does | Control | State |
| --- | --- | --- | --- |
| Defer | Holds a non-critical bill that would take the vault below its cash buffer until it is due, then proposes it | `min_balance`, enforced by the vault; `critical` bills first | Built |
| Deploy idle (yield investment) | Invests cash above the buffer and the next 14 days of bills for yield in the vault's own account at Burrow, NEAR's lending protocol, once a day; withdraws it back to the vault with `recall_from_yield` when bills due soon would break the buffer | Payee kind `yield` with `max_move` and `lending`; the vault refuses larger moves, any move without a buffer, and any withdrawal to anywhere but itself | Built and live on testnet with Burrow (`harvest.keel.testnet`, about 10% APR) |
| Escalate | Proposes anything outside the limits | Owner approval | Built |
| Transfer | Tops up the owner's card and own wallets on NEAR | Approved payees and caps | Built on NEAR; NEAR to the vault's own EVM addresses needs a bridge: quoted through NEAR Intents on mainnet, funded by hand on testnet |
| Convert | Quotes swaps through NEAR Intents | None yet | Not built: the vault holds USDC only |

1. **Burrow, live on testnet.** `harvest.keel.testnet` holds Burrow's test USDC (`usdc.fakes.testnet`, USDC.e), the token Burrow's testnet market lends; vaults created by the factory hold Circle's test USDC, which Burrow testnet does not list. With Keel's agent key: 20 USDC.e deposited into the vault's own Burrow account at about 10.4% APR ([transaction](https://testnet.nearblocks.io/txns/2gji1tfJeQLBXNKpkjbcGbEcy6QKqmzCotDyHcZgVXs8)); 5 withdrawn back to the vault ([transaction](https://testnet.nearblocks.io/txns/izdqBBaYAGE325ZmgsXdMw26VeoBPM7k5WhnroBYHrd)). Then the agent, with two 20 USDC.e bills due and 35 in cash against a 10 buffer, withdrew the remaining 15 of the yield investment ([transaction](https://testnet.nearblocks.io/txns/EiLgEcR8LW54UCAsQRd6veL)) and paid both bills, ending at exactly the buffer.
2. To see it, run `npm run agent -- --once --dry-run --vault harvest.keel.testnet` in `agent/`; you see `yield investment: … in Burrow lending at 10.4% APR`. In the app, `?view=` the owner of `harvest` shows the **Yield investment** card.
3. Run `npm run agent -- --once --dry-run --vault tideline.keel.testnet` in `agent/`. You see `idle cash: 1.00 USDC above the buffer and the next 14 days of bills` and the move to the yield destination planned. Forcing a 2 USDC move there with the agent key is refused on chain (`over the most Keel may move to this yield destination at once`).

## Paying ordinary vendors

Keel pays a destination the owner approved once; it never takes one from an invoice or email by itself.

| The vendor takes | Approve this as the payee | What Keel does |
| --- | --- | --- |
| A NEAR account | The vendor's account | Pays each bill when due, within your caps |
| A USDC address on Base, Ethereum, Arbitrum or Optimism | Nothing to approve: add the bill on that chain | Proposes each payment from the vault's own address on that chain |
| "Pay with USDC" on the invoice | Nothing: the address changes per invoice | Proposes each one to you (bill on Base, Ethereum, Arbitrum or Optimism) |
| A card (domains, software, cloud) | Your crypto card's funding wallet, kind **Company card wallet**, with a balance to keep | Tops the card wallet up to that balance, at most once a day; vendors charge the card as usual |
| Bank transfer only (rent, taxes) | An off-ramp deposit address for that bank account, kind **Bank off-ramp** | Pays it like any bill; the off-ramp sends the bank transfer |

On testnet there is no real card or off-ramp: the demo uses test accounts in their place.

1. To see the cash buffer, run `npm run agent -- --once --dry-run --vault ballast.keel.testnet` in `agent/`. You see the critical Payroll bill proposed (paying it would break the 3 USDC buffer) and the Domain renewal deferred until it is due.
2. To see a card top-up, run `npm run agent -- --once --dry-run --vault meridian.keel.testnet` in `agent/`. You see `Top up Company card wallet to its target balance` and the yearly `Domain renewal` bill.

**Invoice reading:** the hosted app's `/api/read-invoice` (`web/api/read-invoice.ts`) sends the uploaded file to Claude (`claude-haiku-5-5`, structured output) and returns a draft. It stores nothing, refuses files over 3 MB and calls from other sites, and allows 10 invoices per visitor per hour. The draft only fills in the form: the owner still signs `add_bill`, and an address from an invoice that is not an approved payee is flagged and always needs approval. It needs `ANTHROPIC_API_KEY` in the Vercel project's environment variables; without it the form says so and the bill is entered by hand.

## Hosted agent

`.github/workflows/agent.yml` runs `npm run agent -- --once` on GitHub Actions: one round over every vault on `keel.testnet`. Each vault records what it paid and proposed, so a fresh runner picks up where the last one stopped.

GitHub's own schedule (`7,22,37,52 * * * *`) proved unreliable for this repository: it fired once in ten hours. So a free external timer (cron-job.org) starts the workflow every 15 minutes through GitHub's `workflow_dispatch` API, with a fine-grained token that can only run Actions on this repository. Runs it started have all succeeded since Nov 4; a GitHub outage can skip one (seen once as `502 Bad Gateway`), and the next run catches up.

1. To see runs: open the repository's **Actions** tab, then **agent**. Each run's log lists every vault and what Keel did, with transaction links.
2. To run it now: **Actions**, **agent**, **Run workflow**. Tick **Decide but sign nothing** for a dry run.
3. To host your own copy: in **Settings**, **Secrets and variables**, **Actions**, add `KEEL_AGENT_PRIVATE_KEY` (the `private_key` from your agent key file). `ANTHROPIC_API_KEY` or `NEARAI_API_KEY` are optional. The key is a function-call key that only reaches `execute_payment`, `propose_payment` and `recall_from_yield` on each vault, so a leaked secret cannot change limits, approve anything or send a yield investment anywhere but back to the vault.
4. To start it every 15 minutes from outside GitHub: a timer that sends `POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/agent.yml/dispatches` with headers `Authorization: Bearer <token>` and `Accept: application/vnd.github+json` and body `{"ref":"main"}`. GitHub answers `204`.
5. To stop it: **Actions**, **agent**, **…**, **Disable workflow**, and turn off the external timer.

## Limits and known issues

- **Agent hosting:** the agent runs on GitHub Actions every 15 minutes, started by an external timer (see [Hosted agent](#hosted-agent)). A GitHub outage can skip a run; the next one catches up.
- **NEAR Intents:** live quotes work; no mainnet move has been made yet.
- **Sample figures:** the blurred dashboard behind the sign-in panel (such as 48,215.40 USDC) is sample data.
- **Forecast inputs:** bills are the ones the owner lists with `add_bill` (or `config/bills.json` for older vaults), not imported from an accounting system.
- **Learning is rule-based:** Keel drafts a cap change after 3 approvals in a row for one payee, and flags any bill more than 25% above that payee's last 3. It never changes a limit itself.
- **Counterparty check:** on-chain signals and the vault blocklist only; no external risk scoring.
- **EVM address funding:** the vault's EVM address needs USDC and a little ETH for gas on each chain it pays from. Keel says how much is missing; it does not move USDC from NEAR to that address itself (that needs a bridge: NEAR Intents on mainnet, none on testnet). Testnet funds come from each chain's Sepolia faucets.
- **Signed means sendable:** once the MPC network signs an approved transfer, anyone can broadcast it, not only Keel. Keel broadcasts it on its next run. EVM transfers land in nonce order, so if the owner approves them out of order, the later one waits.
- **Older vaults:** each vault keeps the code it was created with. `nova`, `kora`, `lumen` and `vega` predate the once-per-bill rule; `orbit` and `stress` predate the flood limits; `harbor` and `stress2` predate the multi-chain routes (Base only). `anchor` and `multi` have everything but use Keel Test USDC; `beacon` is the first on Circle's USDC, and reads its bills from `config/bills.json`. `keystone` is the first with bills listed on chain; `meridian` adds named payees, card top-ups and yearly bills; `ballast` adds the cash buffer and critical bills; `tideline` adds yield destinations for idle cash; `harvest` invests idle cash at Burrow for yield. Vaults created now get all of it (`vault_code_hash` `CtzDuiAmgqmfozUUbxYCfSTHQWjmhekmd1Qhj4jK8Kmb`).
- **Agent key allowance:** the factory gives the agent key 0.25 NEAR for gas; busy demo vaults used about 0.005 NEAR of it in their first days. NEAR also checks each transaction against the allowance at a worst-case gas price, so Keel asks for at most 200 Tgas (a Burrow deposit), not 300. The owner renews the allowance with `set_agent_key`.
- **Yield investment and the dashboard:** the Overview's total treasury counts the vault's cash only; the yield investment at Burrow shows in its own card. Burrow's testnet lends USDC.e, not Circle's test USDC, so only a vault holding USDC.e can invest there on testnet. Keel does not claim Burrow's farming rewards.
- **Invoice reading:** needs `ANTHROPIC_API_KEY` in the Vercel project; its limit of 10 invoices per visitor per hour is kept per running server, so it is best effort.
- **Single owner:** one full-access key approves everything; multisig approval is not built.

## Libraries and AI-generated code

- [near-sdk 5.30](https://crates.io/crates/near-sdk) and [near-contract-standards 5.30](https://crates.io/crates/near-contract-standards) for the contracts
- [cargo-near 0.22](https://crates.io/crates/cargo-near) to build them, [near-cli-rs 0.30](https://www.npmjs.com/package/near-cli-rs) to deploy and call them
- [near-api-js 7.3](https://www.npmjs.com/package/near-api-js) for the agent's signing, run with [tsx](https://www.npmjs.com/package/tsx); optional [NEAR AI Cloud](https://cloud.near.ai) or Claude through [@anthropic-ai/sdk 1.3](https://www.npmjs.com/package/@anthropic-ai/sdk) for proposal wording; the same SDK in `web/api/` reads uploaded invoices
- [viem 2.57](https://viem.sh) for the agent's Base reads and broadcasts; [@noble/hashes 1.8](https://www.npmjs.com/package/@noble/hashes) for keccak in the app (deriving the vault's Base address)
- [NEAR Connect 0.11](https://www.npmjs.com/package/@hot-labs/near-connect) for wallet sign-in, with [React 19](https://react.dev), [Vite 8](https://vite.dev) and TypeScript 5.9 for the app

Parts of this project are written with AI coding agents (Claude Code).

## License

MIT, see [LICENSE](LICENSE).
