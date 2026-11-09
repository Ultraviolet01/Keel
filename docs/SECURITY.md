# Security

[Back to the README](../README.md) · [What was verified on testnet](VERIFIED.md)

## What protects the money

- **Keel's key reaches three methods.** The factory adds Keel's key to each new vault in the same transaction that creates it, as a NEAR function-call key limited to that vault's `execute_payment`, `propose_payment` and `recall_from_yield`, with a 0.25 NEAR gas allowance. It cannot transfer NEAR, add keys, change the rules, approve or touch another vault. The vault also checks that Keel's key signed each call.
- **No other keys on the vault.** Nobody, Keel included, can sign as the vault outside its rules.
- **Each bill is paid once.** The vault records every bill it pays and refuses a second payment, even after Keel restarts with no memory. A failed transfer frees the bill again.
- **Cash buffer on chain.** With a buffer set, the vault reads its own balance from the token contract before each payment by Keel, counts every other payment still in flight, and refuses if the buffer would break, undoing the day's spend and the bill mark.
- **Only the owner lists bills and payees.** A phished invoice or a compromised agent cannot add work or destinations for Keel; a listed bill still goes through the same bands.
- **The yield investment only comes back to the vault.** `recall_from_yield` withdraws only from the lending market the owner approved, and Burrow pays withdrawals only to the depositing account, the vault.
- **Invoice text is untrusted.** It never reaches the model that writes reasons; the app shows it quoted and marked unverified. Invoice reading returns a draft whose values are re-checked, and an address from an invoice that is not an approved payee is flagged and always needs approval.
- **A stolen agent key cannot flood the vault.** At most 50 proposals wait at once, a newer proposal for the same bill replaces the old one, and Keel's calls are refused once the vault's spare NEAR would fall under 0.2. The owner can always approve, pause, withdraw and remove Keel's key.
- **The founder can fire Keel.** `revoke_agent` deletes the key in one transaction; `set_agent_key` adds one back.
- **Rule changes are public.** Every `update_policy` emits the old value, new value, reason and approver.

**Counterparty check:** before any payment, Keel scores the payee.

| Signal | Source | Verdict |
| --- | --- | --- |
| Blocklisted | Vault blocklist | Block: refuse, sign nothing |
| Account does not exist | `view_account` | Block |
| Contract whose code changed since Keel last saw it | `view_account` code hash | Warn: propose, never pay alone |
| Not an approved payee | Vault allowlist | Warn |
| First payment to this payee | Keel's records and executed proposals | Warn |
