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
//! Every bill carries a `bill_ref`. The vault remembers each bill it paid and
//! refuses to pay the same one again, so a restarted agent that lost its
//! memory cannot pay twice.
//!
//! Cross-chain bills can also be paid from the vault's own address on an EVM
//! chain (Base, Ethereum, Arbitrum, Optimism), through NEAR Chain Signatures: the vault builds the USDC
//! transfer itself and asks NEAR's MPC network to sign it after the owner
//! approves. No third-party server is involved.
//!
//! The owner lists the bills Keel should watch with `add_bill`. Only the
//! owner's signature can add one, so the agent never invents work, and every
//! bill still goes through the same bands when Keel pays it.
//!
//! Amounts are in the token's smallest unit (USDC has 6 decimals, so
//! 100 USDC is `100000000`).

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Allowance, BorshStorageKey,
    Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PromiseResult, PublicKey,
};

const NS_PER_DAY: u64 = 86_400_000_000_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// NEP-145 registration for a new payee on the token contract (0.00125 NEAR).
/// Refunded by the token if the payee is already registered.
const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
/// Cash buffer: reading the vault's balance, then paying from the callback.
const GAS_BALANCE_OF: Gas = Gas::from_tgas(5);
const GAS_BALANCE_CHECKED: Gas = Gas::from_tgas(45);
const MAX_TEXT: usize = 280;
const MAX_BILL_REF: usize = 64;
/// At most this many proposals wait for the owner at once, so a stolen agent
/// key cannot flood the vault's storage or the owner's Approvals page.
const MAX_PENDING: u32 = 50;
/// At most this many bills are listed at once.
const MAX_BILLS: u32 = 50;
/// The EVM chains a bill can name, as the agent and the app call them.
const BILL_CHAINS: [&str; 4] = ["base", "eth", "arb", "op"];
/// What a bill is for, so the forecast and reports can group spending.
const BILL_CATEGORIES: [&str; 8] = ["software", "hosting", "contractors", "payroll", "rent", "taxes", "card", "other"];
/// What a payee is. A card or own wallet can carry a `keep_at` balance that
/// Keel tops up; a yield destination carries a `max_move` limit per move.
const PAYEE_KINDS: [&str; 7] = ["vendor", "employee", "card", "offramp", "own", "yield", "other"];
const MAX_PAYEES: u32 = 100;
/// The agent's calls are refused once the vault's NEAR beyond its storage
/// would drop below this, so the owner always has room to approve, pause
/// and withdraw.
const STORAGE_RESERVE: NearToken = NearToken::from_millinear(200);
/// Methods the agent's key may call, and how much NEAR it may spend on gas.
const AGENT_METHODS: &str = "execute_payment,propose_payment";
const AGENT_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(250);
/// Chain Signatures: gas for the MPC `sign` call and for storing the result.
const GAS_MPC_SIGN: Gas = Gas::from_tgas(150);
const GAS_SIGNED_CALLBACK: Gas = Gas::from_tgas(30);
/// Derivation path for the vault's EVM address. Same address on every EVM chain.
pub const EVM_PATH: &str = "evm";

mod evm;
pub use evm::{EvmRoute, EvmSigned, EvmTransfer};

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Allowlist,
    Blocklist,
    Proposals,
    PaidBills,
    OpenBills,
    EvmRoutes,
    Bills,
    Payees,
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
    /// EVM moves: waiting for NEAR's MPC network to sign.
    Signing,
    /// EVM moves: signed; anyone can broadcast `evm_signed.raw_tx`.
    Signed,
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
    /// Set when this is paid from the vault's EVM address via Chain Signatures.
    pub evm: Option<EvmTransfer>,
    /// `amount` in the EVM token's own decimals, fixed when the proposal is made.
    pub evm_amount: Option<U128>,
    pub evm_signed: Option<EvmSigned>,
    /// The bill this pays. The vault pays each bill at most once.
    pub bill_ref: Option<String>,
}

/// A bill the owner asked Keel to pay. `id` is the `bill_ref` its payment
/// carries; a monthly bill is paid once a month as `<id>:<YYYY-MM>`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Bill {
    pub id: String,
    /// A NEAR account, or a 0x address when `chain` is set.
    pub payee: String,
    pub amount: U128,
    /// First (or only) due date, YYYY-MM-DD.
    pub due: String,
    #[serde(default)]
    pub monthly: bool,
    /// Paid once a year as `<id>:<YYYY>`, on the month and day of `due`.
    #[serde(default)]
    pub yearly: bool,
    /// One of software, hosting, contractors, payroll, rent, taxes, card, other.
    #[serde(default)]
    pub category: Option<String>,
    /// Paid even when cash is tight; non-critical bills wait while paying
    /// them would break the cash buffer.
    #[serde(default)]
    pub critical: bool,
    /// For bills paid on another chain: "base", "eth", "arb" or "op".
    #[serde(default)]
    pub chain: Option<String>,
    /// What the bill is, shown to the owner, for example "Northwind hosting".
    pub label: String,
    #[serde(default)]
    pub memo: Option<String>,
    #[serde(default)]
    pub added_at_ms: u64,
}

/// An approved payee with the owner's name for it. Adding one also puts the
/// account on the allowlist.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payee {
    pub account_id: AccountId,
    pub name: String,
    /// vendor, employee, card, offramp, own or other.
    pub kind: String,
    /// For a card or the owner's own wallet: Keel tops it up to this many
    /// token units when it holds less, inside the vault's limits.
    #[serde(default)]
    pub keep_at: Option<U128>,
    /// For a yield destination: the most Keel may move there in one payment.
    /// Keel moves only cash above the buffer, so a buffer must be set.
    #[serde(default)]
    pub max_move: Option<U128>,
}

/// Owner's changes to the policy. Every field is optional.
#[near(serializers = [json])]
#[derive(Default)]
pub struct PolicyUpdate {
    pub per_payment_cap: Option<U128>,
    pub daily_cap: Option<U128>,
    /// Cash buffer: the agent may not pay if the vault would hold less than this.
    #[serde(default)]
    pub min_balance: Option<U128>,
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
    /// Cash buffer the agent's payments must leave in the vault.
    pub min_balance: U128,
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
    /// NEAR's Chain Signatures contract.
    mpc_id: AccountId,
    /// The EVM chains the owner allows, by chain id, with each chain's token and fee caps.
    evm_routes: IterableMap<u64, EvmRoute>,
    /// Bills paid or being paid, with the time the payment started (ms).
    paid_bills: LookupMap<String, u64>,
    /// Bills with a pending proposal, and that proposal's id.
    open_bills: LookupMap<String, u64>,
    /// Proposals waiting for the owner.
    pending_count: u32,
    /// Bills the owner listed for Keel to pay.
    bills: IterableMap<String, Bill>,
    /// Names and kinds of approved payees.
    payees: IterableMap<AccountId, Payee>,
    /// Cash buffer: the agent may not pay if the vault would hold less than this.
    min_balance: u128,
    /// Agent payments started under the buffer and not finished yet. Counted
    /// against the balance so parallel payments cannot slip under the buffer.
    outflow: u128,
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
            mpc_id: default_mpc(),
            evm_routes: {
                let mut m = IterableMap::new(StorageKey::EvmRoutes);
                for r in default_evm_routes() {
                    m.insert(r.chain_id, r);
                }
                m
            },
            paid_bills: LookupMap::new(StorageKey::PaidBills),
            open_bills: LookupMap::new(StorageKey::OpenBills),
            pending_count: 0,
            bills: IterableMap::new(StorageKey::Bills),
            payees: IterableMap::new(StorageKey::Payees),
            min_balance: 0,
            outflow: 0,
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
        bill_ref: Option<String>,
    ) -> Promise {
        self.assert_agent();
        check_text(memo.as_deref().unwrap_or(""), "memo");
        let check = self.evaluate(&receiver_id, amount.0);
        if check.band != Band::RunsAlone {
            env::panic_str(&format!("Keel Vault refused: {}", check.reason));
        }
        // Idle cash: moves to a yield destination stay under its per-move limit
        // and always go through the cash buffer check.
        if let Some(max) = self.payees.get(&receiver_id).and_then(|p| p.max_move) {
            require!(amount.0 <= max.0, "Keel Vault refused: over the most Keel may move to this yield destination at once");
            require!(self.min_balance > 0, "Keel Vault refused: set a cash buffer before Keel moves idle cash");
        }
        if let Some(r) = &bill_ref {
            self.mark_paid(r);
        }
        let day = today();
        self.spent_today = self.spent_on(day) + amount.0;
        self.spent_day = day;
        emit(
            "payment_started",
            json!({ "receiver_id": receiver_id, "amount": amount, "by": "agent", "rule": check.reason, "bill_ref": bill_ref }),
        );
        self.assert_storage_reserve();
        if self.min_balance == 0 {
            return self.pay(receiver_id, amount, memo, None, Some(day), bill_ref, None);
        }
        // With a cash buffer, ask the token contract for the vault's balance
        // first and pay from the callback only if the buffer still holds.
        self.outflow += amount.0;
        ext_ft::ext(self.token_id.clone())
            .with_static_gas(GAS_BALANCE_OF)
            .ft_balance_of(env::current_account_id())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_BALANCE_CHECKED)
                    .on_balance_checked(receiver_id, amount, memo, day, bill_ref),
            )
    }

    /// Files a proposal for the owner. Used for new payees, amounts over the
    /// cap and cross-chain moves. Blocklisted payees are never proposed.
    /// `valid_until_ms` marks an offer that expires, such as a NEAR Intents
    /// deposit address; the vault refuses to approve it after that time.
    /// `evm` pays the bill from the vault's own EVM address instead; then
    /// `receiver_id` is the payee's lowercase 0x address.
    pub fn propose_payment(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        reason: String,
        valid_until_ms: Option<u64>,
        evm: Option<EvmTransfer>,
        bill_ref: Option<String>,
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
        let evm_amount = evm.as_ref().map(|e| U128(self.check_evm(e, &receiver_id, amount.0)));
        if let Some(r) = &bill_ref {
            check_bill_ref(r);
            require!(!self.paid_bills.contains_key(r), "Keel Vault refused: this bill was already paid");
        }

        let id = self.next_proposal_id;
        if let Some(r) = &bill_ref {
            // A newer proposal for the same bill (a fresh quote, a new nonce)
            // replaces the old one, so only one can ever be approved.
            // The replaced offer is deleted, so repeating a bill cannot grow
            // storage; the event keeps the record.
            if let Some(old) = self.open_bills.insert(r.clone(), id) {
                if self.proposals.get(&old).map(|p| p.status == ProposalStatus::Pending) == Some(true) {
                    let p = self.proposals.remove(&old).unwrap();
                    self.pending_count -= 1;
                    emit("proposal_superseded", json!({ "id": old, "by": id, "bill_ref": r, "receiver_id": p.receiver_id, "amount": p.amount }));
                }
            }
        }
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
            evm,
            evm_amount,
            evm_signed: None,
            bill_ref,
        };
        require!(
            self.pending_count < MAX_PENDING,
            "Keel Vault refused: 50 proposals are already waiting for the owner"
        );
        self.pending_count += 1;
        emit("proposal_created", json!(proposal));
        self.proposals.insert(id, proposal);
        self.assert_storage_reserve();
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
        let bill_ref = proposal.bill_ref.clone();
        let evm = proposal.evm.clone();
        let evm_amount = proposal.evm_amount;
        self.pending_count -= 1;
        proposal.status = if evm.is_some() {
            ProposalStatus::Signing
        } else {
            ProposalStatus::Executing
        };
        let (receiver_id, amount, memo) =
            (proposal.receiver_id.clone(), proposal.amount, proposal.memo.clone());
        emit(
            "proposal_approved",
            json!({ "id": proposal_id, "approved_by": self.owner_id }),
        );
        if let Some(r) = &bill_ref {
            self.open_bills.remove(r);
            self.mark_paid(r);
        }
        match evm {
            Some(e) => {
                // The owner may have changed the route since the proposal.
                let units = self.check_evm(&e, &receiver_id, amount.0);
                require!(Some(U128(units)) == evm_amount, "Keel Vault refused: the route's token changed since the proposal");
                self.sign_evm(proposal_id, &e, units)
            }
            None => self.pay(receiver_id, amount, memo, Some(proposal_id), None, bill_ref, None),
        }
    }

    /// Sets one EVM chain's token and fee limits for Chain Signatures
    /// payments, or turns that chain off with `route: null`.
    #[payable]
    pub fn set_evm_route(&mut self, chain_id: u64, route: Option<EvmRoute>) {
        self.assert_owner();
        if let Some(r) = &route {
            require!(r.chain_id == chain_id, "route.chain_id must match chain_id");
            require!(evm::parse_address(&r.token).is_some(), "token must be a 0x address");
            require!(r.decimals >= VAULT_DECIMALS && r.decimals <= 30, "token decimals must be 6 to 30");
        }
        let old = match &route {
            Some(r) => self.evm_routes.insert(chain_id, r.clone()),
            None => self.evm_routes.remove(&chain_id),
        };
        emit("evm_route_set", json!({ "chain_id": chain_id, "old": old, "new": route, "by": self.owner_id }));
    }

    /// Owner moves funds out of the vault's EVM address, for example back to
    /// their own wallet. Signed straight away; no proposal needed.
    #[payable]
    pub fn withdraw_evm(&mut self, evm: EvmTransfer, amount: U128, memo: Option<String>) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "amount must be above zero");
        check_text(memo.as_deref().unwrap_or(""), "memo");
        let to = evm::normalize_address(&evm.to).unwrap_or_else(|| env::panic_str("payee must be a 0x address"));
        let receiver_id: AccountId = to.parse().unwrap();
        let units = self.check_evm(&evm, &receiver_id, amount.0);
        let id = self.next_proposal_id;
        self.next_proposal_id += 1;
        let proposal = Proposal {
            id,
            receiver_id,
            amount,
            memo,
            reason: "owner withdrawal from the vault's EVM address".into(),
            status: ProposalStatus::Signing,
            created_at_ms: env::block_timestamp_ms(),
            valid_until_ms: None,
            evm: Some(evm.clone()),
            evm_amount: Some(U128(units)),
            evm_signed: None,
            bill_ref: None,
        };
        emit("withdrawal_started", json!(proposal));
        self.proposals.insert(id, proposal);
        self.sign_evm(id, &evm, units)
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
        self.pending_count -= 1;
        if let Some(r) = proposal.bill_ref.clone() {
            if self.open_bills.get(&r) == Some(&proposal_id) {
                self.open_bills.remove(&r);
            }
        }
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
        let old = json!({ "per_payment_cap": U128(self.per_payment_cap), "daily_cap": U128(self.daily_cap), "min_balance": U128(self.min_balance) });

        if let Some(cap) = update.per_payment_cap {
            self.per_payment_cap = cap.0;
        }
        if let Some(cap) = update.daily_cap {
            self.daily_cap = cap.0;
        }
        if let Some(floor) = update.min_balance {
            self.min_balance = floor.0;
        }
        require!(
            self.per_payment_cap <= self.daily_cap,
            "per-payment cap cannot exceed the daily cap"
        );
        for account in &update.disallow {
            self.allowlist.remove(account);
            self.payees.remove(account);
        }
        for account in &update.unblock {
            self.blocklist.remove(account);
        }
        for account in &update.block {
            self.allowlist.remove(account);
            self.payees.remove(account);
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
                "new": { "per_payment_cap": U128(self.per_payment_cap), "daily_cap": U128(self.daily_cap), "min_balance": U128(self.min_balance) },
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
        self.pay(receiver_id, amount, memo, None, None, None, None)
    }

    /// Lists a bill for Keel to pay. Keel still pays it only inside the
    /// policy: within the limits it pays alone, otherwise it proposes it.
    #[payable]
    pub fn add_bill(&mut self, bill: Bill) {
        self.assert_owner();
        check_bill_ref(&bill.id);
        require!(!bill.id.contains(':'), "bill id cannot contain ':'");
        require!(!self.bills.contains_key(&bill.id), "a bill with that id is already listed");
        require!((self.bills.len() as u32) < MAX_BILLS, "50 bills are already listed; cancel one first");
        require!(bill.amount.0 > 0, "amount must be above zero");
        require!(is_date(&bill.due), "due must be a date like 2026-11-30");
        require!(!(bill.monthly && bill.yearly), "a bill repeats monthly or yearly, not both");
        if let Some(c) = &bill.category {
            require!(BILL_CATEGORIES.contains(&c.as_str()), "category must be software, hosting, contractors, payroll, rent, taxes, card or other");
        }
        require!(!bill.label.trim().is_empty(), "label is missing");
        check_text(&bill.label, "label");
        check_text(bill.memo.as_deref().unwrap_or(""), "memo");
        match &bill.chain {
            Some(c) => {
                require!(BILL_CHAINS.contains(&c.as_str()), "chain must be base, eth, arb or op");
                require!(
                    evm::normalize_address(&bill.payee).as_deref() == Some(bill.payee.as_str()),
                    "payee must be a lowercase 0x address on that chain"
                );
            }
            None => require!(bill.payee.parse::<AccountId>().is_ok(), "payee must be a NEAR account id"),
        }
        let bill = Bill { added_at_ms: env::block_timestamp_ms(), ..bill };
        emit("bill_added", json!(bill));
        self.bills.insert(bill.id.clone(), bill);
    }

    /// Approves a payee with a name, for example "Company card". Also puts the
    /// account on the allowlist, so Keel may pay it within the caps.
    #[payable]
    pub fn add_payee(&mut self, payee: Payee) {
        self.assert_owner();
        require!(
            !self.blocklist.contains(&payee.account_id),
            "cannot allow a blocklisted payee; unblock it first"
        );
        require!(!payee.name.trim().is_empty(), "name is missing");
        check_text(&payee.name, "name");
        require!(PAYEE_KINDS.contains(&payee.kind.as_str()), "kind must be vendor, employee, card, offramp, own, yield or other");
        if payee.kind == "yield" {
            require!(payee.max_move.map_or(false, |m| m.0 > 0), "a yield destination needs max_move, the most Keel may move there at once");
        } else {
            require!(payee.max_move.is_none(), "only a yield destination has max_move");
        }
        if let Some(k) = payee.keep_at {
            require!(payee.kind == "card" || payee.kind == "own", "only a card or your own wallet can be kept topped up");
            require!(k.0 > 0, "keep_at must be above zero");
        }
        require!(
            self.payees.contains_key(&payee.account_id) || (self.payees.len() as u32) < MAX_PAYEES,
            "100 payees are already named; remove one first"
        );
        self.allowlist.insert(payee.account_id.clone());
        emit("payee_added", json!(payee));
        self.payees.insert(payee.account_id.clone(), payee);
    }

    /// Removes a payee's name and takes it off the allowlist.
    #[payable]
    pub fn remove_payee(&mut self, account_id: AccountId) {
        self.assert_owner();
        let named = self.payees.remove(&account_id).is_some();
        let allowed = self.allowlist.remove(&account_id);
        require!(named || allowed, "that account is not a payee");
        emit("payee_removed", json!({ "account_id": account_id, "by": self.owner_id }));
    }

    /// Stops Keel watching a bill. Payments already made stay in the ledger.
    #[payable]
    pub fn cancel_bill(&mut self, id: String) {
        self.assert_owner();
        require!(self.bills.remove(&id).is_some(), "no bill with that id");
        emit("bill_cancelled", json!({ "id": id, "by": self.owner_id }));
    }

    /// Lets a bill be paid again. For the rare case where the owner confirms
    /// a payment never arrived, such as a signed EVM transfer whose nonce was
    /// used by another one.
    #[payable]
    pub fn release_bill(&mut self, bill_ref: String) {
        self.assert_owner();
        require!(self.paid_bills.remove(&bill_ref).is_some(), "that bill is not marked paid");
        emit("bill_released", json!({ "bill_ref": bill_ref, "by": self.owner_id }));
    }

    // -------------------------------------------------------------- callback

    /// Cash buffer check: pays only if the vault still holds the buffer after
    /// this payment and every other agent payment in flight. Otherwise undoes
    /// the reservation, the daily spend and the bill mark, and pays nothing.
    #[private]
    pub fn on_balance_checked(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        agent_day: u64,
        bill_ref: Option<String>,
    ) -> PromiseOrValue<bool> {
        #[allow(deprecated)]
        let balance = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => near_sdk::serde_json::from_slice::<U128>(&bytes).ok().map(|b| b.0),
            _ => None,
        };
        let holds = balance.map_or(false, |b| b.saturating_sub(self.outflow) >= self.min_balance);
        if holds {
            return PromiseOrValue::Promise(self.pay(receiver_id, amount, memo, None, Some(agent_day), bill_ref, Some(true)));
        }
        self.outflow = self.outflow.saturating_sub(amount.0);
        if agent_day == self.spent_day {
            self.spent_today = self.spent_today.saturating_sub(amount.0);
        }
        if let Some(r) = &bill_ref {
            self.paid_bills.remove(r);
        }
        emit(
            "payment_refused",
            json!({
                "receiver_id": receiver_id, "amount": amount, "bill_ref": bill_ref,
                "reason": if balance.is_some() { "would take the vault below its cash buffer" } else { "could not read the vault's balance" },
                "min_balance": U128(self.min_balance),
            }),
        );
        PromiseOrValue::Value(false)
    }

    #[private]
    pub fn on_payment_done(
        &mut self,
        proposal_id: Option<u64>,
        receiver_id: AccountId,
        amount: U128,
        agent_day: Option<u64>,
        bill_ref: Option<String>,
        reserved: Option<bool>,
    ) -> bool {
        #[allow(deprecated)]
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
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

    /// Stores the MPC signature as a ready-to-broadcast transaction.
    #[private]
    pub fn on_evm_signed(&mut self, proposal_id: u64) -> Option<EvmSigned> {
        #[allow(deprecated)]
        let result = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => near_sdk::serde_json::from_slice::<Value>(&bytes).ok(),
            _ => None,
        };
        let proposal = self.proposals.get_mut(&proposal_id)?;
        let signed = result.as_ref().and_then(|v| {
            let e = proposal.evm.as_ref()?;
            let big_r = v["big_r"]["affine_point"].as_str()?;
            let s = evm::hex_decode(v["s"]["scalar"].as_str()?)?;
            let r = evm::hex_decode(big_r.get(2..)?)?; // drop the 02/03 prefix: r is the x coordinate
            let y = v["recovery_id"].as_u64()? as u8;
            Some(e.signed(proposal.evm_amount?.0, y, &r, &s))
        });
        proposal.status = if signed.is_some() { ProposalStatus::Signed } else { ProposalStatus::Failed };
        if signed.is_none() {
            if let Some(r) = &proposal.bill_ref {
                self.paid_bills.remove(r);
            }
        }
        proposal.evm_signed = signed.clone();
        emit(
            if signed.is_some() { "evm_signed" } else { "evm_sign_failed" },
            json!({ "proposal_id": proposal_id, "tx_hash": signed.as_ref().map(|x| &x.tx_hash) }),
        );
        signed
    }

    // ----------------------------------------------------------------- views

    /// The EVM routes and the inputs to derive the vault's EVM address
    /// (`derived_public_key` on `mpc_id` with this path and the vault as
    /// predecessor). The address is the same on every EVM chain.
    pub fn get_evm_route(&self) -> Value {
        let routes: Vec<&EvmRoute> = self.evm_routes.values().collect();
        json!({ "routes": routes, "mpc_id": self.mpc_id, "path": EVM_PATH, "predecessor": env::current_account_id() })
    }

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
            min_balance: U128(self.min_balance),
            paused: self.paused,
            allowlist: self.allowlist.iter().cloned().collect(),
            blocklist: self.blocklist.iter().cloned().collect(),
        }
    }

    /// Approved payees the owner named. The allowlist in `get_policy` is the
    /// full list Keel may pay; this adds names, kinds and top-up targets.
    pub fn get_payees(&self) -> Vec<Payee> {
        self.payees.values().cloned().collect()
    }

    /// The bills the owner listed, in no particular order.
    pub fn get_bills(&self) -> Vec<Bill> {
        self.bills.values().cloned().collect()
    }

    /// When the vault started paying this bill (ms), or null if it never did.
    pub fn bill_paid_at(&self, bill_ref: String) -> Option<u64> {
        self.paid_bills.get(&bill_ref).copied()
    }

    pub fn get_proposal(&self, proposal_id: u64) -> Option<Proposal> {
        self.proposals.get(&proposal_id).cloned()
    }

    /// How many proposals wait for the owner (at most 50).
    pub fn pending_count(&self) -> u32 {
        self.pending_count
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

    /// Refuses the agent's call if it would leave the vault without NEAR
    /// headroom for the owner's own actions.
    fn assert_storage_reserve(&self) {
        let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        let free = env::account_balance().saturating_sub(locked);
        require!(
            free >= STORAGE_RESERVE,
            "Keel Vault refused: the vault is low on NEAR for storage; the owner can add NEAR to it"
        );
    }

        fn mark_paid(&mut self, bill_ref: &str) {
        check_bill_ref(bill_ref);
        require!(
            self.paid_bills.insert(bill_ref.to_string(), env::block_timestamp_ms()).is_none(),
            "Keel Vault refused: this bill was already paid"
        );
    }

    /// The checks every EVM transfer passes before the vault signs it.
    /// Returns the amount in the route token's own decimals.
    fn check_evm(&self, e: &EvmTransfer, receiver_id: &AccountId, amount: u128) -> u128 {
        let route = self
            .evm_routes
            .get(&e.chain_id)
            .unwrap_or_else(|| env::panic_str("Keel Vault refused: chain is not one of the vault's EVM routes"));
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
        require!(e.gas_limit <= route.max_gas, "Keel Vault refused: gas limit over the route's maximum");
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

    fn sign_evm(&self, proposal_id: u64, e: &EvmTransfer, amount: u128) -> Promise {
        let hash = e.signing_hash(amount);
        let args = json!({
            "request": { "path": EVM_PATH, "payload_v2": { "Ecdsa": evm::hex_encode(&hash) }, "domain_id": 0 }
        });
        Promise::new(self.mpc_id.clone())
            .function_call("sign", args.to_string().into_bytes(), ONE_YOCTO, GAS_MPC_SIGN)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_SIGNED_CALLBACK)
                    .on_evm_signed(proposal_id),
            )
    }

    fn pay(
        &self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        proposal_id: Option<u64>,
        agent_day: Option<u64>,
        bill_ref: Option<String>,
        reserved: Option<bool>,
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
                    .on_payment_done(proposal_id, receiver_id, amount, agent_day, bill_ref, reserved),
            )
    }
}

fn is_testnet() -> bool {
    env::current_account_id().as_str().ends_with(".testnet")
}

/// NEAR's Chain Signatures contract on this network.
fn default_mpc() -> AccountId {
    (if is_testnet() { "v1.signer-prod.testnet" } else { "v1.signer" }).parse().unwrap()
}

/// The vault's own token (USDC) has 6 decimals; EVM amounts are scaled from it.
const VAULT_DECIMALS: u8 = 6;

/// Circle USDC on each chain (6 decimals). Gas is capped at 100k; the fee cap
/// bounds what a bad quote could burn: 5 gwei on the L2s (0.0005 ETH), 50 gwei
/// on Ethereum (0.005 ETH). The owner can add other chains, including tokens
/// with more decimals, with `set_evm_route`.
fn default_evm_routes() -> Vec<EvmRoute> {
    const GWEI: u128 = 1_000_000_000;
    let r = |chain_id: u64, token: &str, decimals: u8, gwei: u128| EvmRoute {
        chain_id,
        token: token.into(),
        decimals,
        max_fee_per_gas: U128(gwei * GWEI),
        max_gas: 100_000,
    };
    if is_testnet() {
        vec![
            r(84532, "0x036cbd53842c5426634e7929541ec2318f3dcf7e", 6, 5),
            r(11155111, "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", 6, 50),
            r(421614, "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", 6, 5),
            r(11155420, "0x5fd84259d66cd46123540766be93dfe6d43130d7", 6, 5),
        ]
    } else {
        vec![
            r(8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6, 5),
            r(1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6, 50),
            r(42161, "0xaf88d065e77c8cc2239327c5edb3a432268e5831", 6, 5),
            r(10, "0x0b2c639c533813f4aa9d7837caf62653d097ff85", 6, 5),
        ]
    }
}

fn today() -> u64 {
    env::block_timestamp() / NS_PER_DAY
}

fn check_bill_ref(r: &str) {
    require!(!r.is_empty() && r.len() <= MAX_BILL_REF, "bill_ref must be 1 to 64 characters");
}

/// YYYY-MM-DD with a real month and a day from 1 to 31.
fn is_date(d: &str) -> bool {
    let b = d.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| d.get(r).filter(|x| x.bytes().all(|c| c.is_ascii_digit())).and_then(|x| x.parse::<u32>().ok());
    matches!((num(0..4), num(5..7), num(8..10)), (Some(y), Some(m), Some(day)) if y >= 2000 && (1..=12).contains(&m) && (1..=31).contains(&day))
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
