# Keel web app

Founders sign in with a NEAR wallet, create a vault for each company and see each vault's live state. Talks to the factory at `keel.testnet` on NEAR testnet.

## Run it

1. Run `npm install` in this folder. You see the install finish.
2. Run `npm run dev` and open the address it prints. You see "Open a vault for your company" and a Connect wallet button.
3. Click **Connect wallet**. You see the wallet picker (Meteor, Intear, Ledger, Nightly, Ethereum wallets, NEAR CLI) loaded by NEAR Connect.
4. Sign in with a testnet account holding about 3 NEAR. With no companies yet, you see **Create your company's vault**.
5. Type a company name. You see the vault address filled in (for example `kora-supply.keel.testnet`), a live check that the name is free, and the deposit (about 2.62 NEAR).
6. Click **Create**, then approve in your wallet. You see the new company in the sidebar and its Overview: no limits yet, Keel's agent connected, and its balance.
7. Click **+ Add company** to add another; each company gets its own vault.

**Without a wallet:** open `/?view=keel-owner.testnet`. You see that founder's companies read-only, with live data from testnet.

## Build

`npm run build` type-checks and writes `dist/`.

## Files

| File | What it holds |
| --- | --- |
| `src/near.ts` | Network settings, the NEAR Connect connector, read calls over JSON-RPC, number formats |
| `src/App.tsx` | Sign-in, company switcher, create-company form, Overview |
| `src/styles.css` | Fraunces, Hanken Grotesk and Geist Mono on the ink, teal and brass palette from the Figma designs |
