# Keel Vault contract

[Back to the README](../README.md)

## Methods and bands

| Method | Who can call it | What it does |
| --- | --- | --- |
| `execute_payment` | Agent key | Pays an approved payee within the per-payment cap and the rolling 24-hour cap, for a bill the owner set (`bill_ref`, checked by `check_agent_ref`: same payee and amount, once), a top-up of a card or own wallet, or an idle-cash move; with a cash buffer set, only if the vault still holds it afterwards. A payment to a lending market is deposited into the vault's own account there. With `evm`, pays a bill on another chain from the vault's EVM address if it is inside that chain's `auto_cap` and the 0x payee is allowlisted |
| `propose_payment` | Agent key | Files a proposal for a bill the owner set, optionally with an expiry (`valid_until_ms`) or an EVM transfer (`evm`). A NEAR or EVM proposal must pay the bill's own payee its own amount; only a NEAR Intents proposal for a cross-chain bill may name the quote's deposit address. At most 50 wait at once; a newer proposal for the same bill replaces the waiting one, after the same checks |
| `recall_from_yield` | Agent key, or the owner | Withdraws from the vault's approved lending market back into the vault, and nowhere else; works while paused |
| `approve` / `reject` | Owner | Executes or closes a proposal |
| `update_policy` | Owner | Caps, the cash buffer (`min_balance`), allowlist and blocklist; logs old value, new value and reason |
| `add_payee` / `remove_payee` | Owner | Approves a named payee (vendor, employee, card, off-ramp, own wallet, yield destination) and puts it on the allowlist, or removes it |
| `add_bill` / `cancel_bill` | Owner | Lists a bill for Keel (payee, amount, due date, category, once, monthly or yearly, critical, optionally another chain), or stops it. At most 50. The ids `top` and `idle` are reserved |
| `pause` / `resume` | Owner | Stops every payment at once, then restarts them |
| `withdraw` | Owner | Pays out directly; works while paused and ignores the buffer |
| `revoke_agent` / `set_agent_key` | Owner | Removes Keel's key from the vault, or adds one |
| `set_evm_route` / `withdraw_evm` | Owner | Sets or turns off a chain's token and fee caps, and its `auto_cap` (at most the per-payment cap); moves funds out of the vault's EVM address |
| `transfer_owner` / `cancel_owner_transfer` | Owner | Offers the vault to a new owner, such as a Sputnik DAO multisig, or withdraws the offer. Nothing changes until the new owner accepts. Refuses the vault itself and the factory |
| `accept_owner` | The offered account | Takes the vault. The factory records the change first (`record_owner_change`, callable only by a vault it created); the vault switches owner only if the factory accepted |
| `release_bill` | Owner | Lets a bill be paid again after the owner confirms it never arrived |
| `check_payment`, `get_policy`, `get_bills`, `get_payees`, `get_proposals`, `bill_paid_at`, `pending_count`, `get_evm_route` | Anyone (views) | Read the rules, bills, payees, proposals and the vault's EVM address inputs |

| Band | Rule | Result |
| --- | --- | --- |
| Runs alone | A bill the owner set, to an approved payee, within the per-payment cap and the rolling 24-hour cap, and the cash buffer holds (on another chain: also inside its auto cap) | Vault pays; Keel logs and reconciles |
| Needs approval | A new payee, over the per-payment cap, or another chain above its auto cap | Proposal waits for the owner |
| Blocked | Blocklisted payee, vault paused, the 24-hour cap reached, no bill from the owner behind the payment, or (for Keel) the buffer would break | Vault refuses; Keel logs it and holds back or proposes the bill |

Every agent `bill_ref` is one of `<bill id>`, `<bill id>:<YYYY-MM>` (monthly), `<bill id>:<YYYY>` (yearly), `top:<account>:<YYYY-MM-DD>` or `idle:<account>:<YYYY-MM-DD>`; dates are today or yesterday (UTC). Why each rule exists, with the line that enforces it: [SECURITY.md](SECURITY.md).

The vault has no upgrade or migrate method, and neither has the factory: a vault keeps the code it was created with.

Owner methods need exactly 1 yoctoNEAR attached. A function-call key cannot attach a deposit, so only the owner's own wallet can call them. Method details are in [contract/README.md](../contract/README.md).
