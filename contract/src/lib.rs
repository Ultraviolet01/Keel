//! Keel Vault
//!
//! Holds a company's USDC and the rules Keel's agent must stay inside.
//!
//! Keel's agent signs with a function-call access key that lives on the vault
//! account itself and can only call this vault's `execute_payment` and
//! `propose_payment`. The factory adds that key when it creates the vault, so
//! the agent is connected the moment the vault exists. The vault has no other
//! keys; the owner can remove or replace the agent key through the contract.
//! Every other change needs the owner. The vault, not the agent, decides the band:
//!
//! - Runs alone: allowlisted payee, within the per-payment and daily caps.
//! - Needs approval: a new payee or an amount over the per-payment cap.
//!   The agent files a proposal and the owner approves or rejects it.
//! - Blocked: blocklisted payee, vault paused, or the daily cap reached.
//!
//! Amounts are in the token's smallest unit (USDC has 6 decimals, so
//! 100 USDC is `100000000`).

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, IterableSet};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Allowance, BorshStorageKey,
    Gas, NearToken, PanicOnDefault, Promise, PromiseResult, PublicKey,
};

const NS_PER_DAY: u64 = 86_400_000_000_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// NEP-145 registration for a new payee on the token contract (0.00125 NEAR).
/// Refunded by the token if the payee is already registered.
const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const MAX_TEXT: usize = 280;
/// Methods the agent's key may call, and how much NEAR it may spend on gas.
const AGENT_METHODS: &str = "execute_payment,propose_payment";
const AGENT_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(250);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Allowlist,
    Blocklist,
    Proposals,
}

/// Which band a payment lands in.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Band {
    RunsAlone,
    NeedsApproval,
    Blocked,
}

#[near(serializers = [json])]
#[derive(Debug)]
pub struct PaymentCheck {
    pub band: Band,
    pub reason: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Pending,
    Executing,
    Executed,
    Rejected,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub memo: Option<String>,
    pub reason: String,
    pub status: ProposalStatus,
    pub created_at_ms: u64,
    /// For cross-chain moves: the 1Click quote's deadline. Paying its deposit
    /// address after this time can lose the funds, so approval is refused.
    pub valid_until_ms: Option<u64>,
}

/// Owner's changes to the policy. Every field is optional.
#[near(serializers = [json])]
#[derive(Default)]
pub struct PolicyUpdate {
    pub per_payment_cap: Option<U128>,
    pub daily_cap: Option<U128>,
    #[serde(default)]
    pub allow: Vec<AccountId>,
    #[serde(default)]
    pub disallow: Vec<AccountId>,
    #[serde(default)]
    pub block: Vec<AccountId>,
    #[serde(default)]
    pub unblock: Vec<AccountId>,
}

#[near(serializers = [json])]
pub struct PolicyView {
    pub owner_id: AccountId,
    pub agent_key: Option<PublicKey>,
    pub token_id: AccountId,
    pub per_payment_cap: U128,
    pub daily_cap: U128,
    pub spent_today: U128,
    pub paused: bool,
    pub allowlist: Vec<AccountId>,
    pub blocklist: Vec<AccountId>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct KeelVault {
    owner_id: AccountId,
    agent_key: Option<PublicKey>,
    token_id: AccountId,
    per_payment_cap: u128,
    daily_cap: u128,
    spent_day: u64,
    spent_today: u128,
    paused: bool,
    allowlist: IterableSet<AccountId>,
    blocklist: IterableSet<AccountId>,
    proposals: IterableMap<u64, Proposal>,
    next_proposal_id: u64,
}

#[near]
impl KeelVault {
    /// Starts with no policy: both caps are 0 and the allowlist is empty, so
    /// every payment needs the owner's approval until the owner sets limits
    /// with `update_policy`.
    #[init]
    ///
    /// `agent_key` is the public key of Keel's agent. Whoever deploys the
    /// vault (the factory) adds it as a function-call key on the vault account
    /// in the same transaction.
    pub fn new(owner_id: AccountId, agent_key: PublicKey, token_id: AccountId) -> Self {
        Self {
            owner_id,
            agent_key: Some(agent_key),
            token_id,
            per_payment_cap: 0,
            daily_cap: 0,
            spent_day: today(),
            spent_today: 0,
            paused: false,
            allowlist: IterableSet::new(StorageKey::Allowlist),
            blocklist: IterableSet::new(StorageKey::Blocklist),
            proposals: IterableMap::new(StorageKey::Proposals),
            next_proposal_id: 1,
        }
    }

    // ---------------------------------------------------------------- agent

    /// Pays an allowlisted payee within the caps. Anything else is refused,
    /// and the refusal is the failed transaction itself.
    pub fn execute_payment(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> Promise {
        self.assert_agent();
        check_text(memo.as_deref().unwrap_or(""), "memo");
        let check = self.evaluate(&receiver_id, amount.0);
        if check.band != Band::RunsAlone {
            env::panic_str(&format!("Keel Vault refused: {}", check.reason));
        }
        let day = today();
        self.spent_today = self.spent_on(day) + amount.0;
        self.spent_day = day;
        emit(
            "payment_started",
            json!({ "receiver_id": receiver_id, "amount": amount, "by": "agent", "rule": check.reason }),
        );
        self.pay(receiver_id, amount, memo, None, Some(day))
    }

    /// Files a proposal for the owner. Used for new payees, amounts over the
    /// cap and cross-chain moves. Blocklisted payees are never proposed.
    /// `valid_until_ms` marks an offer that expires, such as a NEAR Intents
    /// deposit address; the vault refuses to approve it after that time.
    pub fn propose_payment(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        reason: String,
        valid_until_ms: Option<u64>,
    ) -> u64 {
        self.assert_agent();
        require!(!self.paused, "Keel Vault refused: vault is paused");
        require!(amount.0 > 0, "Keel Vault refused: amount must be above zero");
        require!(
            !self.blocklist.contains(&receiver_id),
            "Keel Vault refused: payee is on the blocklist"
        );
        check_text(&reason, "reason");
        check_text(memo.as_deref().unwrap_or(""), "memo");
        if let Some(t) = valid_until_ms {
            require!(t > env::block_timestamp_ms(), "Keel Vault refused: the offer has already expired");
        }

        let id = self.next_proposal_id;
        self.next_proposal_id += 1;
        let proposal = Proposal {
            id,
            receiver_id,
            amount,
            memo,
            reason,
            status: ProposalStatus::Pending,
            created_at_ms: env::block_timestamp_ms(),
            valid_until_ms,
        };
        emit("proposal_created", json!(proposal));
        self.proposals.insert(id, proposal);
        id
    }

    // ---------------------------------------------------------------- owner
    // Owner methods need 1 yoctoNEAR attached, so only a full-access key can
    // call them: function-call keys cannot attach a deposit.

    #[payable]
    pub fn approve(&mut self, proposal_id: u64) -> Promise {
        self.assert_owner();
        require!(!self.paused, "Keel Vault refused: vault is paused");
        let proposal = self
            .proposals
            .get_mut(&proposal_id)
            .unwrap_or_else(|| env::panic_str("no such proposal"));
        require!(
            proposal.status == ProposalStatus::Pending,
            "proposal is not pending"
        );
        require!(
            !self.blocklist.contains(&proposal.receiver_id),
            "Keel Vault refused: payee is on the blocklist"
        );
        if let Some(t) = proposal.valid_until_ms {
            require!(
                env::block_timestamp_ms() < t,
                "Keel Vault refused: this offer expired; Keel will propose a fresh one"
            );
        }
        proposal.status = ProposalStatus::Executing;
        let (receiver_id, amount, memo) =
            (proposal.receiver_id.clone(), proposal.amount, proposal.memo.clone());
        emit(
            "proposal_approved",
            json!({ "id": proposal_id, "approved_by": self.owner_id }),
        );
        self.pay(receiver_id, amount, memo, Some(proposal_id), None)
    }

    #[payable]
    pub fn reject(&mut self, proposal_id: u64) {
        self.assert_owner();
        let proposal = self
            .proposals
            .get_mut(&proposal_id)
            .unwrap_or_else(|| env::panic_str("no such proposal"));
        require!(
            proposal.status == ProposalStatus::Pending,
            "proposal is not pending"
        );
        proposal.status = ProposalStatus::Rejected;
        emit(
            "proposal_rejected",
            json!({ "id": proposal_id, "rejected_by": self.owner_id }),
        );
    }

    /// Changes caps, allowlist or blocklist. Logs old value, new value,
    /// reason and approver for the public ledger.
    #[payable]
    pub fn update_policy(&mut self, update: PolicyUpdate, reason: String) {
        self.assert_owner();
        check_text(&reason, "reason");
        let old = json!({ "per_payment_cap": U128(self.per_payment_cap), "daily_cap": U128(self.daily_cap) });

        if let Some(cap) = update.per_payment_cap {
            self.per_payment_cap = cap.0;
        }
        if let Some(cap) = update.daily_cap {
            self.daily_cap = cap.0;
        }
        require!(
            self.per_payment_cap <= self.daily_cap,
            "per-payment cap cannot exceed the daily cap"
        );
        for account in &update.disallow {
            self.allowlist.remove(account);
        }
        for account in &update.unblock {
            self.blocklist.remove(account);
        }
        for account in &update.block {
            self.allowlist.remove(account);
            self.blocklist.insert(account.clone());
        }
        for account in &update.allow {
            require!(
                !self.blocklist.contains(account),
                "cannot allow a blocklisted payee; unblock it first"
            );
            self.allowlist.insert(account.clone());
        }

        emit(
            "policy_updated",
            json!({
                "old": old,
                "new": { "per_payment_cap": U128(self.per_payment_cap), "daily_cap": U128(self.daily_cap) },
                "allow": update.allow, "disallow": update.disallow,
                "block": update.block, "unblock": update.unblock,
                "reason": reason, "approved_by": self.owner_id,
            }),
        );
    }

    /// Kill switch: stops every payment and proposal until `resume`.
    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit("paused", json!({ "by": self.owner_id }));
    }

    #[payable]
    pub fn resume(&mut self) {
        self.assert_owner();
        self.paused = false;
        emit("resumed", json!({ "by": self.owner_id }));
    }

    /// Fires the agent: deletes its key from the vault account. The agent
    /// can do nothing until the owner sets a new key.
    #[payable]
    pub fn revoke_agent(&mut self) -> Promise {
        self.assert_owner();
        let old = self
            .agent_key
            .take()
            .unwrap_or_else(|| env::panic_str("there is no agent key to revoke"));
        emit("agent_revoked", json!({ "old_key": old, "by": self.owner_id }));
        Promise::new(env::current_account_id()).delete_key(old)
    }

    /// Replaces the agent's key, for example to rotate it or to hire an agent
    /// again after revoking. The new key can only call `execute_payment` and
    /// `propose_payment` on this vault.
    #[payable]
    pub fn set_agent_key(&mut self, agent_key: PublicKey) -> Promise {
        self.assert_owner();
        let mut batch = Promise::new(env::current_account_id());
        if let Some(old) = self.agent_key.take() {
            require!(old != agent_key, "that key is already the agent key");
            batch = batch.delete_key(old);
        }
        emit("agent_key_set", json!({ "new_key": agent_key, "by": self.owner_id }));
        self.agent_key = Some(agent_key.clone());
        batch.add_access_key_allowance(
            agent_key,
            Allowance::limited(AGENT_KEY_ALLOWANCE).unwrap(),
            env::current_account_id(),
            AGENT_METHODS,
        )
    }

    /// Owner pays out directly, for example back to their own wallet. Works
    /// while paused, so the owner can always get their money out.
    #[payable]
    pub fn withdraw(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "amount must be above zero");
        check_text(memo.as_deref().unwrap_or(""), "memo");
        emit(
            "withdrawal_started",
            json!({ "receiver_id": receiver_id, "amount": amount, "by": self.owner_id }),
        );
        self.pay(receiver_id, amount, memo, None, None)
    }

    // -------------------------------------------------------------- callback

    #[private]
    pub fn on_payment_done(
        &mut self,
        proposal_id: Option<u64>,
        receiver_id: AccountId,
        amount: U128,
        agent_day: Option<u64>,
    ) -> bool {
        #[allow(deprecated)]
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if let Some(id) = proposal_id {
            if let Some(proposal) = self.proposals.get_mut(&id) {
                proposal.status = if ok {
                    ProposalStatus::Executed
                } else {
                    ProposalStatus::Failed
                };
            }
        } else if !ok && agent_day == Some(self.spent_day) {
            // The transfer did not happen, so it should not count against today's cap.
            self.spent_today = self.spent_today.saturating_sub(amount.0);
        }
        emit(
            if ok { "payment_executed" } else { "payment_failed" },
            json!({ "receiver_id": receiver_id, "amount": amount, "proposal_id": proposal_id }),
        );
        ok
    }

    // ----------------------------------------------------------------- views

    /// The band a payment would land in, without moving money.
    pub fn check_payment(&self, receiver_id: AccountId, amount: U128) -> PaymentCheck {
        self.evaluate(&receiver_id, amount.0)
    }

    pub fn get_policy(&self) -> PolicyView {
        PolicyView {
            owner_id: self.owner_id.clone(),
            agent_key: self.agent_key.clone(),
            token_id: self.token_id.clone(),
            per_payment_cap: U128(self.per_payment_cap),
            daily_cap: U128(self.daily_cap),
            spent_today: U128(self.spent_on(today())),
            paused: self.paused,
            allowlist: self.allowlist.iter().cloned().collect(),
            blocklist: self.blocklist.iter().cloned().collect(),
        }
    }

    pub fn get_proposal(&self, proposal_id: u64) -> Option<Proposal> {
        self.proposals.get(&proposal_id).cloned()
    }

    pub fn get_proposals(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Proposal> {
        self.proposals
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }
}

impl KeelVault {
    /// The agent signs with its key on this vault's own account, so the call
    /// comes from the vault itself and is signed by the agent key.
    fn assert_agent(&self) {
        let is_agent = env::predecessor_account_id() == env::current_account_id()
            && self.agent_key.as_ref() == Some(&env::signer_account_pk());
        require!(is_agent, "Keel Vault refused: only the agent can call this");
    }

    fn assert_owner(&self) {
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Keel Vault refused: only the owner can call this"
        );
    }

    fn spent_on(&self, day: u64) -> u128 {
        if self.spent_day == day {
            self.spent_today
        } else {
            0
        }
    }

    fn evaluate(&self, receiver_id: &AccountId, amount: u128) -> PaymentCheck {
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
            .spent_on(today())
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

    fn pay(
        &self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        proposal_id: Option<u64>,
        agent_day: Option<u64>,
    ) -> Promise {
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
                    .on_payment_done(proposal_id, receiver_id, amount, agent_day),
            )
    }
}

fn today() -> u64 {
    env::block_timestamp() / NS_PER_DAY
}

fn check_text(text: &str, field: &str) {
    if text.len() > MAX_TEXT {
        env::panic_str(&format!("{field} is longer than {MAX_TEXT} characters"));
    }
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "keel", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

#[cfg(test)]
mod tests;
