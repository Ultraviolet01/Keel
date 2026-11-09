# Keel Vault contract

[Back to the README](../README.md)

## Methods and bands

| Method | Who can call it | What it does |
| --- | --- | --- |
| `execute_payment` | Agent key | Pays an approved payee within the per-payment and daily caps, once per bill (`bill_ref`); with a cash buffer set, only if the vault still holds it afterwards. A payment to a lending market is deposited into the vault's own account there |
| `propose_payment` | Agent key | Files a proposal, optionally with an expiry (`valid_until_ms`) or an EVM transfer (`evm`). At most 50 wait at once; a newer proposal for the same bill replaces the waiting one |
| `recall_from_yield` | Agent key, or the owner | Withdraws from the vault's approved lending market back into the vault, and nowhere else; works while paused |
| `approve` / `reject` | Owner | Executes or closes a proposal |
| `update_policy` | Owner | Caps, the cash buffer (`min_balance`), allowlist and blocklist; logs old value, new value and reason |
| `add_payee` / `remove_payee` | Owner | Approves a named payee (vendor, employee, card, off-ramp, own wallet, yield destination) and puts it on the allowlist, or removes it |
| `add_bill` / `cancel_bill` | Owner | Lists a bill for Keel (payee, amount, due date, category, once, monthly or yearly, critical, optionally another chain), or stops it. At most 50 |
| `pause` / `resume` | Owner | Stops every payment at once, then restarts them |
| `withdraw` | Owner | Pays out directly; works while paused and ignores the buffer |
| `revoke_agent` / `set_agent_key` | Owner | Removes Keel's key from the vault, or adds one |
| `set_evm_route` / `withdraw_evm` | Owner | Sets or turns off a chain's token and fee caps; moves funds out of the vault's EVM address |
| `transfer_owner` | Owner | Hands the vault to a new owner, such as a Sputnik DAO multisig. The factory records the change first (`record_owner_change`, callable only by a vault it created); the vault switches owner only if the factory accepted |
| `release_bill` | Owner | Lets a bill be paid again after the owner confirms it never arrived |
| `check_payment`, `get_policy`, `get_bills`, `get_payees`, `get_proposals`, `bill_paid_at`, `pending_count`, `get_evm_route` | Anyone (views) | Read the rules, bills, payees, proposals and the vault's EVM address inputs |

| Band | Rule | Result |
| --- | --- | --- |
| Runs alone | Approved payee, within the per-payment and daily caps, and the cash buffer holds | Vault pays; Keel logs and reconciles |
| Needs approval | A new payee, over the per-payment cap, or another chain | Proposal waits for the owner |
| Blocked | Blocklisted payee, vault paused, daily cap reached, or (for Keel) the buffer would break | Vault refuses; Keel logs it and holds back or proposes the bill |

Owner methods need exactly 1 yoctoNEAR attached. A function-call key cannot attach a deposit, so only the owner's own wallet can call them. Method details are in [contract/README.md](../contract/README.md).
