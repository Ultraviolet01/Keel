# Keel web app

Founders connect a NEAR wallet, create a vault for each company, set its limits and approve what Keel proposes. Talks to the factory at `keel.testnet` on NEAR testnet. The layout follows the Figma screens (Landing, Overview, Approvals, Activity, Rules, Wallets, measured from 2x exports) and the mockups in `design/mockups/`.

## Run it

1. Run `npm install` in this folder. You see the install finish.
2. Run `npm run dev` and open the address it prints. You see the landing page, with the ship riding light under its load line and sinking past it when a payment needs your signature. Click **Open app** (or go to `/app`). You see the app blurred behind a **Connect wallet** panel.
3. Click **Connect wallet**. You see the NEAR Connect wallet picker (Meteor, Intear, Ledger, Nightly, Ethereum wallets, NEAR CLI).
4. Sign in with a testnet account holding about 3.5 NEAR. With no company yet, you see **Name your first company** over the blurred app.
5. Type a company name. You see the vault address filled in, a live check that it is free, and the deposit (about 3.15 NEAR). Click **Create vault** and approve in your wallet.
6. You see the Overview for your new company: a **Finish setting up** checklist (vault created, Keel's agent connected, set limits, add payees, deposit), Active rules showing "Not set", and the sidebar status "Keel is waiting for limits".
7. Click **Set limits**, enter a per-payment cap, a daily cap and the payees Keel may pay, and approve. You see Active rules update and the status change to "Keel is running".
8. Open the company card at the top of the sidebar. You see all your companies and **Add company**.
9. Open **Approvals** to approve or reject what Keel proposed, and use **Pause all payments** in the sidebar to stop everything at once.

**Without a wallet:** open `/app?view=keel-owner.testnet`. You see that founder's companies (`anchor`, `nova`, `orbit`, `harbor`, and the older `kora` and `lumen`) read-only, with live testnet data; switch between them in the company card. `/app?view=vega-founder.testnet` shows `vega` and `multi`; their Wallets pages list the vault's own EVM address and its balance on each chain, and whose Approvals page shows Base transfers signed through Chain Signatures. A link to an invalid account, or to one with no vaults, says so.

## What each screen does

| Screen | Reads | Signs (owner wallet, 1 yoctoNEAR) |
| --- | --- | --- |
| Connect wallet | – | – |
| Name your company | factory `get_config`, account availability | factory `create_vault` with the deposit |
| Overview | vault `get_policy`, `get_proposals`, token balance, vault gas | – |
| Approvals | vault `get_proposals`, `check_payment`; offer expiry counts down and Approve turns off once it passes | `approve` (300 Tgas for a Base transfer), `reject` |
| Activity | vault `get_proposals` | – |
| Rules | vault `get_policy` | `update_policy` (Set limits), `revoke_agent` |
| Wallets | token balance, vault gas, the vault's EVM address and its USDC and gas balance on each of its chains (via the MPC contract's `derived_public_key` and each chain's RPC) | – |
| Sidebar status | vault `get_policy` | `pause`, `resume` |

Company names are kept in this browser only; the chain stores the vault address.

## Test

`npm test` runs the checks for the NEAR Intents deposit-address verification (`src/intents.test.ts`), including one live call to the 1Click API.

## Build

`npm run build` type-checks and writes `dist/`.

## Files

| File | What it holds |
| --- | --- |
| `src/Landing.tsx` | Landing page at `/`, with the ship drawn in SVG |
| `src/App.tsx` | The app at `/app`: wallet session, which screen shows, transaction sending |
| `src/Sidebar.tsx` | Company switcher, nav, Keel status box with pause and resume |
| `src/panels.tsx` | Connect wallet, Name your company, Set limits and Deposit panels |
| `src/pages.tsx` | Overview, Approvals, Activity, Rules, Wallets |
| `src/Sample.tsx` | The sample treasury shown blurred behind the first panels |
| `src/vault.ts` | Reads one vault's live state |
| `src/near.ts` | Network settings, NEAR Connect, JSON-RPC reads, number formats |
| `src/intents.ts` | Asks 1Click where a deposit address pays before the owner approves it |
| `src/evm.ts` | The vault's EVM address from Chain Signatures, and its balances on each chain |
| `src/icons.tsx` | Line icons and Keel's load-line mark |
| `src/styles.css` | Tokens sampled from the Figma screens |
