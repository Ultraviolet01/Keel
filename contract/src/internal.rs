//! The vault's internal steps: who may call, the rule checks behind every agent
//! payment, the rolling cap, and the transfers themselves.

use super::*;

impl KeelVault {
    /// The last step of an agent payment on NEAR: straight to the transfer, or
    /// through the cash buffer check when a buffer is set.
    pub(crate) fn continue_payment(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        at: u64,
        bill_ref: Option<String>,
    ) -> Promise {
        if self.min_balance == 0 {
            return self.pay(receiver_id, amount, memo, None, Some(at), bill_ref, None);
        }
        // With a cash buffer, ask the token contract for the vault's balance
        // first and pay from the callback only if the buffer still holds.
        self.outflow += amount.0;
        let gas = if self.is_lending(&receiver_id) {
            GAS_BALANCE_CHECKED_LENDING
        } else {
            GAS_BALANCE_CHECKED
        };
        ext_ft::ext(self.token_id.clone())
            .with_static_gas(GAS_BALANCE_OF)
            .ft_balance_of(env::current_account_id())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(gas)
                    .on_balance_checked(receiver_id, amount, memo, at, bill_ref),
            )
    }
}

impl KeelVault {
    pub(crate) fn settle(
        &mut self,
        ok: bool,
        proposal_id: Option<u64>,
        receiver_id: AccountId,
        amount: U128,
        agent_at: Option<u64>,
        bill_ref: Option<String>,
        reserved: Option<bool>,
    ) -> bool {
        if reserved == Some(true) {
            self.outflow = self.outflow.saturating_sub(amount.0);
        }
        if !ok {
            // Nothing was paid, so the bill can be paid again.
            if let Some(r) = &bill_ref {
                self.paid_bills.remove(r);
            }
        }
        if let Some(id) = proposal_id {
            if let Some(proposal) = self.proposals.get_mut(&id) {
                proposal.status = if ok {
                    ProposalStatus::Executed
                } else {
                    ProposalStatus::Failed
                };
            }
        } else if let (false, Some(at)) = (ok, agent_at) {
            // The transfer did not happen, so it should not count against the cap.
            self.unspend(at, amount.0);
        }
        emit(
            if ok {
                "payment_executed"
            } else {
                "payment_failed"
            },
            json!({ "receiver_id": receiver_id, "amount": amount, "proposal_id": proposal_id }),
        );
        ok
    }

    /// The agent signs with its key on this vault's own account, so the call
    /// comes from the vault itself and is signed by the agent key.
    pub(crate) fn assert_agent(&self) {
        let is_agent = env::predecessor_account_id() == env::current_account_id()
            && self.agent_key.as_ref() == Some(&env::signer_account_pk());
        require!(is_agent, "Keel Vault refused: only the agent can call this");
    }

    pub(crate) fn is_lending(&self, account: &AccountId) -> bool {
        self.payees.get(account).map_or(false, |p| p.lending)
    }

    pub(crate) fn assert_owner(&self) {
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Keel Vault refused: only the owner can call this"
        );
    }

    /// What the agent paid in the 24 hours before `now` (ns).
    pub(crate) fn spent_window(&self, now: u64) -> u128 {
        self.spent
            .iter()
            .filter(|(t, _)| t.saturating_add(NS_PER_DAY) > now)
            .map(|(_, a)| a)
            .sum()
    }

    pub(crate) fn record_spend(&mut self, now: u64, amount: u128) {
        self.spent
            .retain(|(t, _)| t.saturating_add(NS_PER_DAY) > now);
        require!(
            self.spent.len() < MAX_SPENT_ENTRIES,
            "Keel Vault refused: 200 agent payments in 24 hours already"
        );
        self.spent.push((now, amount));
    }

    /// Gives back an agent payment that did not happen (or happened in part).
    pub(crate) fn unspend(&mut self, at: u64, amount: u128) {
        if let Some(i) = self
            .spent
            .iter()
            .position(|(t, a)| *t == at && *a >= amount)
        {
            self.spent[i].1 -= amount;
            if self.spent[i].1 == 0 {
                self.spent.remove(i);
            }
        }
    }

    /// The agent's `bill_ref` must name something the owner set, and the
    /// payment must match it. A stolen agent key can therefore only pay the
    /// owner's own bills, to their payees, for their amounts, once each.
    pub(crate) fn check_agent_ref(
        &self,
        r: &str,
        receiver: &AccountId,
        amount: u128,
        use_: RefUse,
    ) {
        check_bill_ref(r);
        let near_only = || {
            require!(
                !matches!(use_, RefUse::Evm(_)),
                "Keel Vault refused: top-ups and idle cash stay on NEAR"
            )
        };
        if let Some(rest) = r.strip_prefix("top:") {
            near_only();
            let payee = self.payees.get(receiver);
            let keep = payee.and_then(|p| p.keep_at).unwrap_or_else(|| {
                env::panic_str(
                    "Keel Vault refused: top-ups only go to a card or own wallet with a target",
                )
            });
            self.check_dated(rest, receiver);
            require!(
                amount <= keep.0,
                "Keel Vault refused: a top-up cannot be more than the wallet's target balance"
            );
        } else if let Some(rest) = r.strip_prefix("idle:") {
            near_only();
            let max = self
                .payees
                .get(receiver)
                .and_then(|p| p.max_move)
                .unwrap_or_else(|| {
                    env::panic_str("Keel Vault refused: idle cash only goes to a yield destination")
                });
            self.check_dated(rest, receiver);
            require!(
                amount <= max.0,
                "Keel Vault refused: over the most Keel may move to this yield destination at once"
            );
        } else {
            let (id, period) = match r.split_once(':') {
                Some((id, p)) => (id, Some(p)),
                None => (r, None),
            };
            let bill = self
                .bills
                .get(id)
                .unwrap_or_else(|| env::panic_str("Keel Vault refused: no such bill"));
            check_period(bill, period);
            match (use_, bill.chain.as_deref()) {
                (RefUse::Near | RefUse::Proposal, None) => require!(
                    bill.payee == receiver.as_str() && bill.amount.0 == amount,
                    "Keel Vault refused: payment does not match the owner's bill"
                ),
                (RefUse::Evm(chain_id), Some(c)) => {
                    require!(
                        chain_ids(c).contains(&chain_id),
                        "Keel Vault refused: the bill is on another chain"
                    );
                    require!(
                        bill.payee == receiver.as_str() && bill.amount.0 == amount,
                        "Keel Vault refused: payment does not match the owner's bill"
                    );
                }
                // NEAR Intents: the receiver is the quote's deposit address, new with
                // every quote, so it cannot be the bill's payee. The vault still bounds
                // it: the receiver must have the shape of a 1Click deposit address (a
                // 64-character implicit account) and the amount, which includes the
                // swap, at most 3% over the bill. The app also asks 1Click where the
                // address pays (web/src/intents.ts), and the owner approves every one.
                (RefUse::Proposal, Some(_)) => {
                    require!(
                        is_implicit(receiver.as_str()),
                        "Keel Vault refused: a cross-chain proposal must pay a 1Click deposit address"
                    );
                    require!(
                        amount <= intents_max(bill.amount.0),
                        "Keel Vault refused: more than 3% over the bill for a cross-chain swap"
                    );
                }
                _ => env::panic_str("Keel Vault refused: payment does not match the owner's bill"),
            }
        }
    }

    /// `<account>:<YYYY-MM-DD>` of a top-up or idle move: the account is the
    /// receiver (its first 45 characters) and the date is today (UTC), so each
    /// wallet gets at most one per calendar day.
    pub(crate) fn check_dated(&self, rest: &str, receiver: &AccountId) {
        let (acct, date) = rest
            .rsplit_once(':')
            .unwrap_or_else(|| env::panic_str("Keel Vault refused: malformed bill_ref"));
        let prefix: String = receiver.as_str().chars().take(45).collect();
        require!(
            acct == prefix,
            "Keel Vault refused: the bill_ref names another payee"
        );
        require!(
            date == civil_date(env::block_timestamp() / NS_PER_DAY),
            "Keel Vault refused: a top-up or idle move must be dated today"
        );
    }

    pub(crate) fn evaluate(&self, receiver_id: &AccountId, amount: u128) -> PaymentCheck {
        let (band, reason) = if self.paused {
            (Band::Blocked, "vault is paused".to_string())
        } else if amount == 0 {
            (Band::Blocked, "amount must be above zero".to_string())
        } else if self.blocklist.contains(receiver_id) {
            (Band::Blocked, "payee is on the blocklist".to_string())
        } else if !self.allowlist.contains(receiver_id) {
            (
                Band::NeedsApproval,
                "new payee, not on the allowlist".to_string(),
            )
        } else if amount > self.per_payment_cap {
            (
                Band::NeedsApproval,
                format!("over the per-payment cap of {}", self.per_payment_cap),
            )
        } else if self
            .spent_window(env::block_timestamp())
            .checked_add(amount)
            .map_or(true, |total| total > self.daily_cap)
        {
            (
                Band::Blocked,
                format!("daily cap of {} reached", self.daily_cap),
            )
        } else {
            (
                Band::RunsAlone,
                "allowlisted payee within the per-payment and daily caps".to_string(),
            )
        };
        PaymentCheck { band, reason }
    }

    /// Refuses the agent's call if it would leave the vault without NEAR
    /// headroom for the owner's own actions.
    pub(crate) fn assert_storage_reserve(&self) {
        let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        let free = env::account_balance().saturating_sub(locked);
        require!(
            free >= STORAGE_RESERVE,
            "Keel Vault refused: the vault is low on NEAR for storage; the owner can add NEAR to it"
        );
    }

    pub(crate) fn mark_paid(&mut self, bill_ref: &str) {
        check_bill_ref(bill_ref);
        require!(
            self.paid_bills
                .insert(bill_ref.to_string(), env::block_timestamp_ms())
                .is_none(),
            "Keel Vault refused: this bill was already paid"
        );
    }

    /// The checks every EVM transfer passes before the vault signs it.
    /// Returns the amount in the route token's own decimals.
    pub(crate) fn check_evm(&self, e: &EvmTransfer, receiver_id: &AccountId, amount: u128) -> u128 {
        let route = self.evm_routes.get(&e.chain_id).unwrap_or_else(|| {
            env::panic_str("Keel Vault refused: chain is not one of the vault's EVM routes")
        });
        require!(
            evm::normalize_address(&e.token) == evm::normalize_address(&route.token),
            "Keel Vault refused: only the route's token can be sent"
        );
        let to = evm::normalize_address(&e.to)
            .unwrap_or_else(|| env::panic_str("Keel Vault refused: payee must be a 0x address"));
        require!(
            receiver_id.as_str() == to,
            "Keel Vault refused: receiver_id must be the payee's lowercase 0x address"
        );
        require!(
            e.gas_limit <= route.max_gas,
            "Keel Vault refused: gas limit over the route's maximum"
        );
        require!(
            e.max_fee_per_gas.0 <= route.max_fee_per_gas.0,
            "Keel Vault refused: fee over the route's maximum"
        );
        require!(
            e.max_priority_fee_per_gas.0 <= e.max_fee_per_gas.0,
            "Keel Vault refused: priority fee above the max fee"
        );
        10u128
            .checked_pow((route.decimals - VAULT_DECIMALS) as u32)
            .and_then(|scale| amount.checked_mul(scale))
            .unwrap_or_else(|| env::panic_str("Keel Vault refused: amount too large for the token"))
    }

    pub(crate) fn sign_evm(&self, proposal_id: u64, e: &EvmTransfer, amount: u128) -> Promise {
        let hash = e.signing_hash(amount);
        let args = json!({
            "request": { "path": EVM_PATH, "payload_v2": { "Ecdsa": evm::hex_encode(&hash) }, "domain_id": 0 }
        });
        Promise::new(self.mpc_id.clone())
            .function_call(
                "sign",
                args.to_string().into_bytes(),
                ONE_YOCTO,
                GAS_MPC_SIGN,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_SIGNED_CALLBACK)
                    .on_evm_signed(proposal_id),
            )
    }

    pub(crate) fn pay(
        &self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        proposal_id: Option<u64>,
        agent_at: Option<u64>,
        bill_ref: Option<String>,
        reserved: Option<bool>,
    ) -> Promise {
        if self.is_lending(&receiver_id) {
            // A deposit into the vault's own account at the lending market.
            let transfer = ext_ft::ext(self.token_id.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_TRANSFER_CALL)
                .ft_transfer_call(receiver_id.clone(), amount, memo, String::new());
            let done = Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_deposit_done(
                    proposal_id,
                    receiver_id.clone(),
                    amount,
                    agent_at,
                    bill_ref,
                    reserved,
                );
            if self.lending_registered.contains(&receiver_id) {
                return transfer.then(done);
            }
            return ext_lending::ext(receiver_id.clone())
                .with_attached_deposit(LENDING_STORAGE)
                .with_static_gas(GAS_LENDING_REGISTER)
                .storage_deposit(Some(env::current_account_id()), Some(true))
                .then(transfer)
                .then(done);
        }
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(STORAGE_DEPOSIT)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(receiver_id.clone()), Some(true))
            .then(
                ext_ft::ext(self.token_id.clone())
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FT_TRANSFER)
                    .ft_transfer(receiver_id.clone(), amount, memo),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_payment_done(
                        proposal_id,
                        receiver_id,
                        amount,
                        agent_at,
                        bill_ref,
                        reserved,
                    ),
            )
    }
}
