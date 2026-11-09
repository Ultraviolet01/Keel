use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, RuntimeFeesConfig};

const USDC: u128 = 1_000_000; // 6 decimals
const DAY: u64 = NS_PER_DAY;

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

const VAULT: &str = "vault.kora.testnet";
const AGENT_KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const OTHER_KEY: &str = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847";

fn pk(key: &str) -> PublicKey {
    key.parse().unwrap()
}

fn ctx(predecessor: &str, signer_key: &str, at: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(VAULT))
        .predecessor_account_id(acc(predecessor))
        .signer_account_pk(pk(signer_key))
        .block_timestamp(at)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

fn set_ctx(predecessor: &str, at: u64, deposit: u128) {
    ctx(predecessor, OTHER_KEY, at, deposit);
}

/// The agent signs with its key on the vault's own account.
fn as_agent(at: u64) {
    ctx(VAULT, AGENT_KEY, at, 0);
}

fn as_agent_with_deposit(at: u64, deposit: u128) {
    ctx(VAULT, AGENT_KEY, at, deposit);
}

fn as_owner(at: u64) {
    set_ctx("kora.testnet", at, 1);
}

fn fresh_vault() -> KeelVault {
    as_owner(DAY);
    KeelVault::new(acc("kora.testnet"), pk(AGENT_KEY), acc("usdc.testnet"))
}

/// A vault after the owner sets a sample policy: 100 USDC per payment,
/// 500 per day, Northwind allowlisted and one address blocklisted.
fn vault() -> KeelVault {
    let mut v = fresh_vault();
    as_owner(DAY);
    v.update_policy(
        PolicyUpdate {
            per_payment_cap: Some(U128(100 * USDC)),
            daily_cap: Some(U128(500 * USDC)),
            allow: vec![acc("northwind.testnet"), acc("payroll.kora.testnet")],
            block: vec![acc("scam.testnet")],
            ..Default::default()
        },
        "demo setup".into(),
    );
    v
}

// ------------------------------------------------- bills behind agent calls

/// The test context, so a helper can act as the owner and then put it back.
struct Saved(AccountId, PublicKey, u64, u128, u128, u64);

fn saved() -> Saved {
    Saved(
        env::predecessor_account_id(),
        env::signer_account_pk(),
        env::block_timestamp(),
        env::attached_deposit().as_yoctonear(),
        env::account_balance().as_yoctonear(),
        env::storage_usage(),
    )
}

fn restore(c: Saved) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(VAULT))
        .predecessor_account_id(c.0)
        .signer_account_pk(c.1)
        .block_timestamp(c.2)
        .attached_deposit(NearToken::from_yoctonear(c.3))
        .account_balance(NearToken::from_yoctonear(c.4))
        .storage_usage(c.5)
        .build());
}

fn chain_name(chain_id: u64) -> &'static str {
    match chain_id {
        84532 | 8453 => "base",
        11155111 | 1 => "eth",
        421614 | 42161 => "arb",
        _ => "op",
    }
}

/// Lists a one-off bill as the owner (if it is not listed yet), then puts the context back.
fn ensure_bill(v: &mut KeelVault, id: &str, payee: &str, amount: u128, chain: Option<&str>) {
    if v.bills.get(id).is_some() {
        return;
    }
    let c = saved();
    as_owner(c.2);
    v.add_bill(Bill {
        amount: U128(amount),
        chain: chain.map(String::from),
        ..listed(id, payee, 1)
    });
    restore(c);
}

fn auto_ref(v: &KeelVault) -> String {
    format!("auto-{}", v.bills.len())
}

/// The agent pays a bill the owner listed for exactly this payee and amount.
fn pay(v: &mut KeelVault, payee: &str, amount: u128) -> Promise {
    let r = auto_ref(v);
    pay_ref(v, payee, amount, &r)
}

fn pay_ref(v: &mut KeelVault, payee: &str, amount: u128, r: &str) -> Promise {
    if !r.starts_with("top:") && !r.starts_with("idle:") {
        ensure_bill(v, r.split(':').next().unwrap(), payee, amount, None);
    }
    v.execute_payment(acc(payee), U128(amount), None, Some(r.into()), None)
}

/// The agent proposes a bill the owner listed: a NEAR bill, or a cross-chain
/// one when it carries an EVM transfer or an Intents deadline.
fn propose(
    v: &mut KeelVault,
    payee: &str,
    amount: u128,
    reason: &str,
    valid: Option<u64>,
    evm: Option<EvmTransfer>,
    r: Option<&str>,
) -> u64 {
    let r = r.map(String::from).unwrap_or_else(|| auto_ref(v));
    if !r.starts_with("top:") && !r.starts_with("idle:") {
        let id = r.split(':').next().unwrap().to_string();
        match (&evm, valid) {
            (Some(e), _) => ensure_bill(
                v,
                &id,
                &e.to.to_lowercase(),
                amount,
                Some(chain_name(e.chain_id)),
            ),
            (None, Some(_)) => ensure_bill(
                v,
                &id,
                "0x00000000000000000000000000000000000000bb",
                amount,
                Some("base"),
            ),
            _ => ensure_bill(v, &id, payee, amount, None),
        }
    }
    v.propose_payment(
        acc(payee),
        U128(amount),
        None,
        reason.into(),
        valid,
        evm,
        Some(r),
    )
}

#[test]
fn new_vault_has_no_policy_and_needs_approval_for_everything() {
    let v = fresh_vault();
    let policy = v.get_policy();
    assert_eq!(policy.per_payment_cap, U128(0));
    assert_eq!(policy.daily_cap, U128(0));
    assert!(policy.allowlist.is_empty() && policy.blocklist.is_empty());
    as_agent(DAY);
    let check = v.check_payment(acc("northwind.testnet"), U128(1 * USDC));
    assert_eq!(check.band, Band::NeedsApproval);
}

#[test]
#[should_panic(expected = "Keel Vault refused: new payee")]
fn new_vault_refuses_agent_payments_until_owner_sets_policy() {
    let mut v = fresh_vault();
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 1 * USDC);
}

#[test]
fn agent_pays_allowlisted_payee_under_cap() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 80 * USDC);
    assert_eq!(v.get_policy().spent_today, U128(80 * USDC));
    assert!(get_logs().iter().any(|l| l.contains("payment_started")));
}

#[test]
#[should_panic(expected = "Keel Vault refused: over the per-payment cap")]
fn refuses_payment_over_cap() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 101 * USDC);
}

#[test]
#[should_panic(expected = "Keel Vault refused: new payee")]
fn refuses_new_payee() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay(&mut v, "stranger.testnet", 10 * USDC);
}

#[test]
#[should_panic(expected = "Keel Vault refused: payee is on the blocklist")]
fn refuses_blocklisted_payee() {
    // The attack demo: even if the agent is tricked, the vault says no.
    let mut v = vault();
    as_agent(DAY);
    let _ = pay(&mut v, "scam.testnet", 1 * USDC);
}

#[test]
#[should_panic(expected = "Keel Vault refused: daily cap")]
fn refuses_after_daily_cap() {
    let mut v = vault();
    as_agent(DAY);
    for _ in 0..5 {
        let _ = pay(&mut v, "northwind.testnet", 100 * USDC);
    }
    let _ = pay(&mut v, "northwind.testnet", 1 * USDC);
}

#[test]
fn daily_cap_frees_24_hours_after_the_payments() {
    let mut v = vault();
    as_agent(DAY);
    for _ in 0..5 {
        let _ = pay(&mut v, "northwind.testnet", 100 * USDC);
    }
    as_agent(2 * DAY + 1);
    let _ = pay(&mut v, "northwind.testnet", 100 * USDC);
    assert_eq!(v.get_policy().spent_today, U128(100 * USDC));
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn only_agent_can_execute() {
    let mut v = vault();
    set_ctx("someone.testnet", DAY, 0);
    let _ = pay(&mut v, "northwind.testnet", 10 * USDC);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the owner can call this")]
fn agent_cannot_change_policy() {
    let mut v = vault();
    as_agent_with_deposit(DAY, 1);
    v.update_policy(
        PolicyUpdate {
            per_payment_cap: Some(U128(1_000_000 * USDC)),
            ..Default::default()
        },
        "raise my own limit".into(),
    );
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_methods_need_full_access_key() {
    // Function-call keys cannot attach a deposit, so this fails without 1 yocto.
    let mut v = vault();
    set_ctx("kora.testnet", DAY, 0);
    v.pause();
}

#[test]
fn pause_blocks_everything_until_resume() {
    let mut v = vault();
    as_owner(DAY);
    v.pause();
    let check = v.check_payment(acc("northwind.testnet"), U128(10 * USDC));
    assert_eq!(check.band, Band::Blocked);
    assert_eq!(check.reason, "vault is paused");

    as_owner(DAY);
    v.resume();
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 10 * USDC);
}

#[test]
#[should_panic(expected = "Keel Vault refused: vault is paused")]
fn paused_vault_refuses_payment() {
    let mut v = vault();
    as_owner(DAY);
    v.pause();
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 10 * USDC);
}

#[test]
fn check_payment_reports_each_band() {
    let v = vault();
    as_agent(DAY);
    let band = |who: &str, amount: u128| v.check_payment(acc(who), U128(amount * USDC)).band;
    assert_eq!(band("northwind.testnet", 80), Band::RunsAlone);
    assert_eq!(band("northwind.testnet", 8_000), Band::NeedsApproval);
    assert_eq!(band("stranger.testnet", 10), Band::NeedsApproval);
    assert_eq!(band("scam.testnet", 10), Band::Blocked);
    assert_eq!(band("northwind.testnet", 0), Band::Blocked);
}

#[test]
fn proposal_flow_approve() {
    let mut v = vault();
    as_agent(DAY);
    let id = propose(
        &mut v,
        "payroll.kora.testnet",
        8_000 * USDC,
        "Payroll short 6,920 for Nov 7",
        None,
        None,
        None,
    );
    assert_eq!(id, 1);
    assert_eq!(v.get_proposal(1).unwrap().status, ProposalStatus::Pending);

    as_owner(DAY);
    let _ = v.approve(1);
    assert_eq!(v.get_proposal(1).unwrap().status, ProposalStatus::Executing);
    // Approved moves do not count against the agent's own daily cap.
    assert_eq!(v.get_policy().spent_today, U128(0));
}

#[test]
fn proposal_flow_reject() {
    let mut v = vault();
    as_agent(DAY);
    propose(
        &mut v,
        "stranger.testnet",
        50 * USDC,
        "new vendor",
        None,
        None,
        None,
    );
    as_owner(DAY);
    v.reject(1);
    assert_eq!(v.get_proposal(1).unwrap().status, ProposalStatus::Rejected);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the owner can call this")]
fn agent_cannot_approve_its_own_proposal() {
    let mut v = vault();
    as_agent(DAY);
    propose(
        &mut v,
        "stranger.testnet",
        50 * USDC,
        "new vendor",
        None,
        None,
        None,
    );
    as_agent_with_deposit(DAY, 1);
    let _ = v.approve(1);
}

#[test]
#[should_panic(expected = "Keel Vault refused: payee is on the blocklist")]
fn blocklisted_payee_is_never_proposed() {
    let mut v = vault();
    as_agent(DAY);
    propose(
        &mut v,
        "scam.testnet",
        950 * USDC,
        "urgent invoice",
        None,
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "Keel Vault refused: payee is on the blocklist")]
fn approval_refused_if_payee_blocked_later() {
    let mut v = vault();
    as_agent(DAY);
    propose(
        &mut v,
        "stranger.testnet",
        50 * USDC,
        "new vendor",
        None,
        None,
        None,
    );
    as_owner(DAY);
    v.update_policy(
        PolicyUpdate {
            block: vec![acc("stranger.testnet")],
            ..Default::default()
        },
        "reported as scam".into(),
    );
    as_owner(DAY);
    let _ = v.approve(1);
}

#[test]
fn policy_update_logs_old_and_new_values() {
    let mut v = vault();
    as_owner(DAY);
    v.update_policy(
        PolicyUpdate {
            per_payment_cap: Some(U128(140 * USDC)),
            ..Default::default()
        },
        "Atlas Freight bills rose steadily".into(),
    );
    let log = get_logs().join("\n");
    assert!(log.contains("policy_updated"));
    assert!(log.contains("\"per_payment_cap\":\"100000000\""));
    assert!(log.contains("\"per_payment_cap\":\"140000000\""));
    assert!(log.contains("Atlas Freight bills rose steadily"));
    assert_eq!(v.get_policy().per_payment_cap, U128(140 * USDC));
}

#[test]
#[should_panic(expected = "cannot allow a blocklisted payee")]
fn cannot_allow_blocklisted_payee() {
    let mut v = vault();
    as_owner(DAY);
    v.update_policy(
        PolicyUpdate {
            allow: vec![acc("scam.testnet")],
            ..Default::default()
        },
        "oops".into(),
    );
}

#[test]
fn rotating_agent_key_locks_out_old_one() {
    let mut v = vault();
    as_owner(DAY);
    let _ = v.set_agent_key(pk(OTHER_KEY));
    assert_eq!(v.get_policy().agent_key, Some(pk(OTHER_KEY)));
    ctx(VAULT, OTHER_KEY, DAY, 0);
    let _ = pay(&mut v, "northwind.testnet", 10 * USDC);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn old_agent_key_refused_after_rotation() {
    let mut v = vault();
    as_owner(DAY);
    let _ = v.set_agent_key(pk(OTHER_KEY));
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 10 * USDC);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn revoked_agent_can_do_nothing() {
    let mut v = vault();
    as_owner(DAY);
    let _ = v.revoke_agent();
    assert_eq!(v.get_policy().agent_key, None);
    assert!(get_logs().iter().any(|l| l.contains("agent_revoked")));
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 10 * USDC);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the owner can call this")]
fn agent_cannot_change_its_own_key() {
    let mut v = vault();
    as_agent_with_deposit(DAY, 1);
    let _ = v.set_agent_key(pk(OTHER_KEY));
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn another_key_on_the_vault_is_not_the_agent() {
    // Even a call from the vault's own account is refused unless the agent key signed it.
    let mut v = vault();
    ctx(VAULT, OTHER_KEY, DAY, 0);
    let _ = pay(&mut v, "northwind.testnet", 10 * USDC);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn agent_key_from_another_account_is_refused() {
    let mut v = vault();
    ctx("agent.kora.testnet", AGENT_KEY, DAY, 0);
    let _ = pay(&mut v, "northwind.testnet", 10 * USDC);
}

#[test]
fn failed_transfer_is_refunded_to_daily_cap() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 100 * USDC);
    assert_eq!(v.get_policy().spent_today, U128(100 * USDC));

    // The token transfer fails; the callback runs as the vault itself.
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc("vault.kora.testnet"))
            .predecessor_account_id(acc("vault.kora.testnet"))
            .block_timestamp(DAY)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    let ok = v.on_payment_done(
        None,
        acc("northwind.testnet"),
        U128(100 * USDC),
        Some(DAY),
        None,
        None,
    );
    assert!(!ok);
    assert_eq!(v.get_policy().spent_today, U128(0));
    assert!(get_logs().iter().any(|l| l.contains("payment_failed")));
}

#[test]
fn approved_proposal_marked_executed_on_success() {
    let mut v = vault();
    as_agent(DAY);
    propose(
        &mut v,
        "payroll.kora.testnet",
        8_000 * USDC,
        "payroll",
        None,
        None,
        None,
    );
    as_owner(DAY);
    let _ = v.approve(1);

    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc("vault.kora.testnet"))
            .predecessor_account_id(acc("vault.kora.testnet"))
            .block_timestamp(DAY)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])],
    );
    assert!(v.on_payment_done(
        Some(1),
        acc("payroll.kora.testnet"),
        U128(8_000 * USDC),
        None,
        None,
        None
    ));
    assert_eq!(v.get_proposal(1).unwrap().status, ProposalStatus::Executed);
}

#[test]
fn owner_can_withdraw_even_while_paused() {
    let mut v = vault();
    as_owner(DAY);
    v.pause();
    as_owner(DAY);
    let _ = v.withdraw(acc("kora.testnet"), U128(250 * USDC), None);
    assert!(get_logs().iter().any(|l| l.contains("withdrawal_started")));
    // Owner withdrawals never count against the agent's daily cap.
    assert_eq!(v.get_policy().spent_today, U128(0));
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the owner can call this")]
fn agent_cannot_withdraw() {
    let mut v = vault();
    as_agent_with_deposit(DAY, 1);
    let _ = v.withdraw(acc("attacker.testnet"), U128(1 * USDC), None);
}

#[test]
fn failed_owner_withdrawal_does_not_touch_agent_cap() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 60 * USDC);
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc("vault.kora.testnet"))
            .predecessor_account_id(acc("vault.kora.testnet"))
            .block_timestamp(DAY)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    v.on_payment_done(
        None,
        acc("kora.testnet"),
        U128(500 * USDC),
        None,
        None,
        None,
    );
    assert_eq!(v.get_policy().spent_today, U128(60 * USDC));
}

const MS: u64 = 1_000_000; // block timestamps are in nanoseconds

/// 1Click deposit addresses on NEAR are 64-character implicit accounts.
const DEPOSIT: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const DEPOSIT2: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

#[test]
fn intents_offer_can_be_approved_before_it_expires() {
    let mut v = vault();
    as_agent(DAY);
    let deadline = DAY / MS + 10 * 60 * 1000; // ten minutes from now, in ms
    propose(
        &mut v,
        DEPOSIT,
        5 * USDC,
        "Move 5 USDC to Base via NEAR Intents",
        Some(deadline),
        None,
        None,
    );
    assert_eq!(v.get_proposal(1).unwrap().valid_until_ms, Some(deadline));
    as_owner(DAY + 5 * 60 * 1_000_000_000);
    let _ = v.approve(1);
    assert_eq!(v.get_proposal(1).unwrap().status, ProposalStatus::Executing);
}

#[test]
#[should_panic(expected = "Keel Vault refused: this offer expired")]
fn expired_intents_offer_is_never_paid() {
    let mut v = vault();
    as_agent(DAY);
    let deadline = DAY / MS + 10 * 60 * 1000;
    propose(
        &mut v,
        DEPOSIT,
        5 * USDC,
        "Move 5 USDC to Base",
        Some(deadline),
        None,
        None,
    );
    as_owner(DAY + 11 * 60 * 1_000_000_000);
    let _ = v.approve(1);
}

#[test]
#[should_panic(expected = "Keel Vault refused: the offer has already expired")]
fn cannot_propose_an_offer_that_already_expired() {
    let mut v = vault();
    as_agent(DAY);
    propose(
        &mut v,
        DEPOSIT,
        5 * USDC,
        "stale",
        Some(DAY / MS - 1),
        None,
        None,
    );
}

// ------------------------------------------------------- Chain Signatures (EVM)

const BASE_USDC: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const PAYEE_EVM: &str = "0x00000000000000000000000000000000000000aa";

/// Same fields as the viem reference vector in the comments below.
fn evm_transfer() -> EvmTransfer {
    EvmTransfer {
        chain_id: 84532,
        token: BASE_USDC.into(),
        to: PAYEE_EVM.into(),
        nonce: 7,
        max_fee_per_gas: U128(1_200_000),
        max_priority_fee_per_gas: U128(1_000_000),
        gas_limit: 60_000,
    }
}

fn propose_evm(v: &mut KeelVault, e: EvmTransfer) -> u64 {
    as_agent(DAY);
    let to = e.to.to_lowercase();
    propose(
        v,
        &to,
        5 * USDC,
        "Pay Base invoice",
        Some(DAY / MS + 30 * 60 * 1000),
        Some(e),
        None,
    )
}

#[test]
fn testnet_vault_starts_with_the_base_sepolia_route() {
    let v = vault();
    let r = v.get_evm_route();
    let ids: Vec<u64> = r["routes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["chain_id"].as_u64().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![84532, 11155111, 421614, 11155420],
        "Base, Ethereum, Arbitrum and Optimism Sepolia"
    );
    assert_eq!(r["routes"][0]["token"], BASE_USDC);
    assert_eq!(r["mpc_id"], "v1.signer-prod.testnet");
    assert_eq!(r["path"], "evm");
}

#[test]
fn signing_hash_matches_an_independent_encoder() {
    // keccak256 of the unsigned EIP-1559 tx, from viem 2.57 serializeTransaction.
    as_owner(DAY);
    let h = evm_transfer().signing_hash(5 * USDC);
    assert_eq!(
        evm::hex_encode(&h),
        "28c19d3c600e2595face7d838940a731f1a04932fe88a1d1c13d70a165b913ec"
    );
}

#[test]
fn approving_an_evm_bill_asks_the_mpc_network_to_sign() {
    let mut v = vault();
    let id = propose_evm(&mut v, evm_transfer());
    as_owner(DAY);
    let _ = v.approve(id);
    assert_eq!(v.get_proposal(id).unwrap().status, ProposalStatus::Signing);
}

#[test]
fn mpc_signature_becomes_a_ready_to_send_transaction() {
    let mut v = vault();
    let id = propose_evm(&mut v, evm_transfer());
    as_owner(DAY);
    let _ = v.approve(id);
    // MPC response shape; r, s and recovery id from the viem reference signature.
    let resp = json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": "025c6e69e75081d7de31709775b841b75f4dc12011d31dc9a5a2a888f99b791e79" },
        "s": { "scalar": "09684768e1ccf0be4c0108262549d72a762f22bd086eb57cd01fb9069f82cdd9" },
        "recovery_id": 1
    });
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(VAULT))
            .predecessor_account_id(acc(VAULT))
            .block_timestamp(DAY)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(resp.to_string().into_bytes())],
    );
    let signed = v.on_evm_signed(id).unwrap();
    assert_eq!(signed.raw_tx, "0x02f8b083014a3407830f424083124f8082ea6094036cbd53842c5426634e7929541ec2318f3dcf7e80b844a9059cbb00000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000004c4b40c001a05c6e69e75081d7de31709775b841b75f4dc12011d31dc9a5a2a888f99b791e79a009684768e1ccf0be4c0108262549d72a762f22bd086eb57cd01fb9069f82cdd9");
    assert_eq!(
        signed.tx_hash,
        "0x194031f3ca2b5111d5e2e69530e6f744f9b9ccac59b1770d0a59b31a718e04a5"
    );
    assert_eq!(v.get_proposal(id).unwrap().status, ProposalStatus::Signed);
}

#[test]
fn failed_mpc_call_marks_the_bill_failed() {
    let mut v = vault();
    let id = propose_evm(&mut v, evm_transfer());
    as_owner(DAY);
    let _ = v.approve(id);
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(VAULT))
            .predecessor_account_id(acc(VAULT))
            .block_timestamp(DAY)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    assert!(v.on_evm_signed(id).is_none());
    assert_eq!(v.get_proposal(id).unwrap().status, ProposalStatus::Failed);
}

#[test]
#[should_panic(expected = "chain is not one of the vault's EVM routes")]
fn evm_bill_on_another_chain_is_refused() {
    let mut v = vault();
    propose_evm(
        &mut v,
        EvmTransfer {
            chain_id: 1,
            ..evm_transfer()
        },
    );
}

#[test]
#[should_panic(expected = "only the route's token can be sent")]
fn evm_bill_for_another_token_is_refused() {
    let mut v = vault();
    propose_evm(
        &mut v,
        EvmTransfer {
            token: "0x00000000000000000000000000000000000000bb".into(),
            ..evm_transfer()
        },
    );
}

#[test]
#[should_panic(expected = "fee over the route's maximum")]
fn evm_bill_with_a_huge_fee_is_refused() {
    let mut v = vault();
    propose_evm(
        &mut v,
        EvmTransfer {
            max_fee_per_gas: U128(6_000_000_000),
            max_priority_fee_per_gas: U128(1),
            ..evm_transfer()
        },
    );
}

#[test]
#[should_panic(expected = "gas limit over the route's maximum")]
fn evm_bill_with_too_much_gas_is_refused() {
    let mut v = vault();
    propose_evm(
        &mut v,
        EvmTransfer {
            gas_limit: 500_000,
            ..evm_transfer()
        },
    );
}

#[test]
#[should_panic(expected = "receiver_id must be the payee's lowercase 0x address")]
fn evm_receiver_must_match_the_payee() {
    let mut v = vault();
    as_agent(DAY);
    propose(
        &mut v,
        "northwind.testnet",
        5 * USDC,
        "x",
        None,
        Some(evm_transfer()),
        None,
    );
}

#[test]
#[should_panic(expected = "payee is on the blocklist")]
fn blocklisted_evm_address_is_refused() {
    let mut v = vault();
    as_owner(DAY);
    v.update_policy(
        PolicyUpdate {
            block: vec![acc(PAYEE_EVM)],
            ..Default::default()
        },
        "scam wallet".into(),
    );
    propose_evm(&mut v, evm_transfer());
}

#[test]
#[should_panic(expected = "chain is not one of the vault's EVM routes")]
fn owner_can_turn_the_evm_route_off() {
    let mut v = vault();
    as_owner(DAY);
    v.set_evm_route(84532, None);
    propose_evm(&mut v, evm_transfer());
}

#[test]
#[should_panic(expected = "chain is not one of the vault's EVM routes")]
fn route_turned_off_after_proposal_blocks_approval() {
    let mut v = vault();
    let id = propose_evm(&mut v, evm_transfer());
    as_owner(DAY);
    v.set_evm_route(84532, None);
    let _ = v.approve(id);
}

#[test]
#[should_panic(expected = "only the owner can call this")]
fn only_the_owner_sets_the_evm_route() {
    let mut v = vault();
    set_ctx("mallory.testnet", DAY, 1);
    v.set_evm_route(84532, None);
}

#[test]
fn owner_can_withdraw_from_the_evm_address() {
    let mut v = vault();
    as_owner(DAY);
    let _ = v.withdraw_evm(evm_transfer(), U128(5 * USDC), None);
    let p = v.get_proposal(1).unwrap();
    assert_eq!(p.status, ProposalStatus::Signing);
    assert_eq!(p.receiver_id.as_str(), PAYEE_EVM);
}

// ------------------------------------------------------ each bill paid once

fn callback_result(ok: bool) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(VAULT))
            .predecessor_account_id(acc(VAULT))
            .block_timestamp(DAY)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![if ok {
            PromiseResult::Successful(vec![])
        } else {
            PromiseResult::Failed
        }],
    );
}

#[test]
#[should_panic(expected = "Keel Vault refused: this bill was already paid")]
fn agent_cannot_pay_the_same_bill_twice() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-nov");
    assert!(v.bill_paid_at("nw-nov".into()).is_some());
    // The agent restarts, forgets, and tries again.
    as_agent(DAY + 60_000_000_000);
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-nov");
}

#[test]
fn different_bills_to_the_same_payee_are_both_paid() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-nov");
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-dec");
    assert_eq!(v.get_policy().spent_today, U128(160 * USDC));
}

#[test]
fn a_failed_transfer_frees_the_bill_to_be_paid_again() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-nov");
    callback_result(false);
    v.on_payment_done(
        None,
        acc("northwind.testnet"),
        U128(80 * USDC),
        Some(DAY),
        Some("nw-nov".into()),
        None,
    );
    assert_eq!(v.bill_paid_at("nw-nov".into()), None);
    as_agent(DAY);
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-nov");
}

#[test]
#[should_panic(expected = "Keel Vault refused: this bill was already paid")]
fn a_paid_bill_cannot_be_proposed() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-nov");
    propose(
        &mut v,
        "northwind.testnet",
        80 * USDC,
        "again",
        None,
        None,
        Some("nw-nov"),
    );
}

#[test]
#[should_panic(expected = "Keel Vault refused: this bill was already paid")]
fn approving_a_bill_already_paid_is_refused() {
    let mut v = vault();
    as_agent(DAY);
    propose(
        &mut v,
        "northwind.testnet",
        80 * USDC,
        "waiting",
        None,
        None,
        Some("nw-nov"),
    );
    // Later the agent pays the same bill directly, inside the caps.
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-nov");
    as_owner(DAY);
    let _ = v.approve(1);
}

#[test]
fn a_newer_proposal_for_the_same_bill_replaces_the_old_one() {
    let mut v = vault();
    as_agent(DAY);
    let deadline = Some(DAY / MS + 10 * 60 * 1000);
    propose(
        &mut v,
        DEPOSIT,
        5 * USDC,
        "quote 1",
        deadline,
        None,
        Some("base-oct"),
    );
    propose(
        &mut v,
        DEPOSIT2,
        5 * USDC,
        "quote 2",
        deadline,
        None,
        Some("base-oct"),
    );
    assert!(v.get_proposal(1).is_none(), "the replaced offer is deleted");
    assert_eq!(v.pending_count(), 1);
    assert_eq!(v.get_proposal(2).unwrap().status, ProposalStatus::Pending);
    assert!(get_logs().iter().any(|l| l.contains("proposal_superseded")));
}

#[test]
#[should_panic(expected = "no such proposal")]
fn a_superseded_proposal_cannot_be_approved() {
    let mut v = vault();
    as_agent(DAY);
    let deadline = Some(DAY / MS + 10 * 60 * 1000);
    propose(
        &mut v,
        DEPOSIT,
        5 * USDC,
        "quote 1",
        deadline,
        None,
        Some("base-oct"),
    );
    propose(
        &mut v,
        DEPOSIT2,
        5 * USDC,
        "quote 2",
        deadline,
        None,
        Some("base-oct"),
    );
    as_owner(DAY);
    let _ = v.approve(1);
}

#[test]
fn approving_marks_the_bill_paid_and_rejecting_does_not() {
    let mut v = vault();
    as_agent(DAY);
    propose(
        &mut v,
        "atlas.testnet",
        50 * USDC,
        "a",
        None,
        None,
        Some("atlas-1"),
    );
    propose(
        &mut v,
        "atlas.testnet",
        50 * USDC,
        "b",
        None,
        None,
        Some("atlas-2"),
    );
    as_owner(DAY);
    let _ = v.approve(1);
    v.reject(2);
    assert!(v.bill_paid_at("atlas-1".into()).is_some());
    assert_eq!(v.bill_paid_at("atlas-2".into()), None);
    // A rejected bill can be proposed again.
    as_agent(DAY);
    assert_eq!(
        propose(
            &mut v,
            "atlas.testnet",
            50 * USDC,
            "c",
            None,
            None,
            Some("atlas-2")
        ),
        3
    );
}

#[test]
fn a_failed_mpc_signature_frees_the_bill() {
    let mut v = vault();
    as_agent(DAY);
    let to = PAYEE_EVM.to_string();
    propose(
        &mut v,
        &to,
        5 * USDC,
        "base",
        None,
        Some(evm_transfer()),
        Some("base-oct"),
    );
    as_owner(DAY);
    let _ = v.approve(1);
    assert!(v.bill_paid_at("base-oct".into()).is_some());
    callback_result(false);
    assert!(v.on_evm_signed(1).is_none());
    assert_eq!(v.bill_paid_at("base-oct".into()), None);
}

#[test]
fn owner_can_release_a_bill_that_never_arrived() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-nov");
    as_owner(DAY);
    v.release_bill("nw-nov".into());
    assert_eq!(v.bill_paid_at("nw-nov".into()), None);
}

#[test]
#[should_panic(expected = "only the owner can call this")]
fn only_the_owner_can_release_a_bill() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-nov");
    ctx(VAULT, AGENT_KEY, DAY, 1);
    v.release_bill("nw-nov".into());
}

#[test]
#[should_panic(expected = "bill_ref must be 1 to 64 characters")]
fn bill_ref_must_be_short() {
    let mut v = vault();
    as_agent(DAY);
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, &"x".repeat(65));
}

// ------------------------------------------------- storage flood by a stolen agent key

/// 9 November 2026, noon UTC.
const NOV9: u64 = 20_766 * DAY + DAY / 2;

/// 26 monthly bills due from 1 November 2026, so on 9 November each can be
/// proposed for this month and next: 52 possible proposals.
fn monthly_bills(v: &mut KeelVault) {
    as_owner(NOV9);
    for i in 0..26 {
        v.add_bill(Bill {
            monthly: true,
            due: "2026-11-01".into(),
            ..listed(&format!("m{i}"), "atlas.testnet", 1)
        });
    }
    as_agent(NOV9);
}

fn monthly_ref(n: usize) -> String {
    format!("m{}:2026-1{}", n / 2, 1 + n % 2)
}

#[test]
fn approving_or_rejecting_frees_a_waiting_slot() {
    let mut v = vault();
    monthly_bills(&mut v);
    for i in 0..50 {
        as_agent(NOV9); // each proposal is its own transaction
        propose(
            &mut v,
            "atlas.testnet",
            USDC,
            "x",
            None,
            None,
            Some(&monthly_ref(i)),
        );
    }
    as_owner(NOV9);
    v.reject(1);
    let _ = v.approve(2);
    assert_eq!(v.pending_count(), 48);
    as_agent(NOV9);
    propose(
        &mut v,
        "atlas.testnet",
        USDC,
        "x",
        None,
        None,
        Some(&monthly_ref(50)),
    );
    propose(
        &mut v,
        "atlas.testnet",
        USDC,
        "x",
        None,
        None,
        Some(&monthly_ref(51)),
    );
    assert_eq!(v.pending_count(), 50);
}

#[test]
#[should_panic(expected = "50 proposals are already waiting")]
fn at_most_50_proposals_wait_at_once() {
    let mut v = vault();
    monthly_bills(&mut v);
    for i in 0..51 {
        as_agent(NOV9); // each proposal is its own transaction
        propose(
            &mut v,
            "atlas.testnet",
            USDC,
            "flood",
            None,
            None,
            Some(&monthly_ref(i)),
        );
    }
}

#[test]
fn reproposing_one_bill_forever_keeps_one_record() {
    let mut v = vault();
    as_agent(DAY);
    for _ in 0..200 {
        as_agent(DAY); // one transaction per proposal
        propose(
            &mut v,
            "atlas.testnet",
            USDC,
            &"r".repeat(280),
            None,
            None,
            Some("same-bill"),
        );
    }
    assert_eq!(v.pending_count(), 1);
    assert_eq!(v.get_proposals(None, Some(100)).len(), 1);
}

fn low_on_near() {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(VAULT))
        .predecessor_account_id(acc(VAULT))
        .signer_account_pk(pk(AGENT_KEY))
        .block_timestamp(DAY)
        .storage_usage(100_000)
        // 100 kB costs 1 NEAR; leave 0.1 NEAR spare, under the 0.2 reserve.
        .account_balance(NearToken::from_millinear(1_100))
        .build());
}

#[test]
#[should_panic(expected = "the vault is low on NEAR for storage")]
fn agent_cannot_propose_into_the_storage_reserve() {
    let mut v = vault();
    low_on_near();
    propose(&mut v, "atlas.testnet", USDC, "x", None, None, Some("low"));
}

#[test]
#[should_panic(expected = "the vault is low on NEAR for storage")]
fn agent_cannot_pay_into_the_storage_reserve() {
    let mut v = vault();
    low_on_near();
    let _ = pay_ref(&mut v, "northwind.testnet", USDC, "low");
}

#[test]
fn owner_can_still_act_when_the_vault_is_low_on_near() {
    let mut v = vault();
    as_agent(DAY);
    propose(&mut v, "atlas.testnet", USDC, "x", None, None, Some("p"));
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(VAULT))
        .predecessor_account_id(acc("kora.testnet"))
        .attached_deposit(NearToken::from_yoctonear(1))
        .block_timestamp(DAY)
        .storage_usage(100_000)
        .account_balance(NearToken::from_millinear(1_100))
        .build());
    v.pause();
    v.resume();
    let _ = v.approve(1);
    let _ = v.withdraw(acc("kora.testnet"), U128(USDC), None);
}

// ------------------------------------------------------- more EVM chains

#[test]
fn arbitrum_sepolia_bill_is_accepted() {
    let mut v = vault();
    let id = propose_evm(
        &mut v,
        EvmTransfer {
            chain_id: 421614,
            token: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d".into(),
            ..evm_transfer()
        },
    );
    assert_eq!(v.get_proposal(id).unwrap().evm_amount, Some(U128(5 * USDC)));
}

#[test]
#[should_panic(expected = "only the route's token can be sent")]
fn base_usdc_cannot_be_sent_on_the_arbitrum_route() {
    let mut v = vault();
    propose_evm(
        &mut v,
        EvmTransfer {
            chain_id: 421614,
            ..evm_transfer()
        },
    );
}

#[test]
fn an_18_decimal_token_gets_the_amount_scaled() {
    let mut v = vault();
    as_owner(DAY);
    // An owner-added chain whose stablecoin has 18 decimals.
    let token18 = "0x00000000000000000000000000000000000000c8";
    v.set_evm_route(
        84532,
        Some(EvmRoute {
            chain_id: 84532,
            token: token18.into(),
            decimals: 18,
            max_fee_per_gas: U128(5_000_000_000),
            max_gas: 100_000,
            auto_cap: None,
        }),
    );
    let id = propose_evm(
        &mut v,
        EvmTransfer {
            token: token18.into(),
            ..evm_transfer()
        },
    );
    // 5 USDC is 5 * 10^18 units of an 18-decimal token.
    assert_eq!(
        v.get_proposal(id).unwrap().evm_amount,
        Some(U128(5 * 10u128.pow(18)))
    );
}

#[test]
#[should_panic(expected = "the route's token changed since the proposal")]
fn changing_a_routes_decimals_after_the_proposal_blocks_approval() {
    let mut v = vault();
    let id = propose_evm(&mut v, evm_transfer());
    as_owner(DAY);
    v.set_evm_route(
        84532,
        Some(EvmRoute {
            chain_id: 84532,
            token: BASE_USDC.into(),
            decimals: 18,
            max_fee_per_gas: U128(5_000_000_000),
            max_gas: 100_000,
            auto_cap: None,
        }),
    );
    let _ = v.approve(id);
}

#[test]
#[should_panic(expected = "route.chain_id must match chain_id")]
fn route_chain_id_must_match() {
    let mut v = vault();
    as_owner(DAY);
    v.set_evm_route(
        1,
        Some(EvmRoute {
            chain_id: 56,
            token: BASE_USDC.into(),
            decimals: 6,
            max_fee_per_gas: U128(1),
            max_gas: 1,
            auto_cap: None,
        }),
    );
}

#[test]
#[should_panic(expected = "token decimals must be 6 to 30")]
fn token_with_fewer_decimals_than_the_vault_is_refused() {
    let mut v = vault();
    as_owner(DAY);
    v.set_evm_route(
        1,
        Some(EvmRoute {
            chain_id: 1,
            token: BASE_USDC.into(),
            decimals: 2,
            max_fee_per_gas: U128(1),
            max_gas: 1,
            auto_cap: None,
        }),
    );
}

#[test]
fn ethereum_sepolia_allows_a_higher_fee_than_base() {
    let mut v = vault();
    let eth_usdc = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
    // 40 gwei: over Base's 5 gwei cap, under Ethereum's 50.
    propose_evm(
        &mut v,
        EvmTransfer {
            chain_id: 11155111,
            token: eth_usdc.into(),
            max_fee_per_gas: U128(40_000_000_000),
            max_priority_fee_per_gas: U128(1_000_000_000),
            ..evm_transfer()
        },
    );
}

#[test]
fn optimism_sepolia_bill_is_accepted() {
    let mut v = vault();
    let op_usdc = "0x5fd84259d66cd46123540766be93dfe6d43130d7";
    let id = propose_evm(
        &mut v,
        EvmTransfer {
            chain_id: 11155420,
            token: op_usdc.into(),
            ..evm_transfer()
        },
    );
    assert_eq!(v.get_proposal(id).unwrap().evm_amount, Some(U128(5 * USDC)));
}

// ------------------------------------------------------------------ bills

fn listed(id: &str, payee: &str, usdc: u128) -> Bill {
    Bill {
        id: id.into(),
        payee: payee.into(),
        amount: U128(usdc * USDC),
        due: "2026-11-30".into(),
        monthly: false,
        yearly: false,
        category: None,
        critical: false,
        chain: None,
        label: "Northwind hosting".into(),
        memo: None,
        added_at_ms: 0,
    }
}

#[test]
fn owner_adds_lists_and_cancels_bills() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(listed("nw-nov", "northwind.testnet", 40));
    v.add_bill(Bill {
        chain: Some("arb".into()),
        payee: "0x000000000000000000000000000000000000dead".into(),
        monthly: true,
        ..listed("lisbon", "x", 12)
    });
    let bills = v.get_bills();
    assert_eq!(bills.len(), 2);
    assert!(bills
        .iter()
        .any(|b| b.id == "lisbon" && b.monthly && b.chain.as_deref() == Some("arb")));
    assert!(get_logs().iter().any(|l| l.contains("\"bill_added\"")));
    as_owner(DAY);
    v.cancel_bill("nw-nov".into());
    assert_eq!(v.get_bills().len(), 1);
    assert!(get_logs().iter().any(|l| l.contains("\"bill_cancelled\"")));
}

#[test]
#[should_panic(expected = "only the owner can call this")]
fn agent_cannot_add_a_bill() {
    let mut v = vault();
    set_ctx(VAULT, DAY, 1);
    v.add_bill(listed("nw-nov", "northwind.testnet", 40));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn adding_a_bill_needs_a_full_access_key() {
    let mut v = vault();
    set_ctx("kora.testnet", DAY, 0);
    v.add_bill(listed("nw-nov", "northwind.testnet", 40));
}

#[test]
#[should_panic(expected = "only the owner can call this")]
fn stranger_cannot_cancel_a_bill() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(listed("nw-nov", "northwind.testnet", 40));
    set_ctx("mallory.testnet", DAY, 1);
    v.cancel_bill("nw-nov".into());
}

#[test]
#[should_panic(expected = "a bill with that id is already listed")]
fn bill_ids_are_unique() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(listed("nw-nov", "northwind.testnet", 40));
    v.add_bill(listed("nw-nov", "northwind.testnet", 41));
}

#[test]
fn bad_bills_are_refused() {
    let cases: Vec<(Bill, &str)> = vec![
        (
            listed("", "northwind.testnet", 1),
            "bill_ref must be 1 to 64 characters",
        ),
        (
            listed("a:b", "northwind.testnet", 1),
            "bill id cannot contain ':'",
        ),
        (
            listed("zero", "northwind.testnet", 0),
            "amount must be above zero",
        ),
        (
            Bill {
                due: "2026-13-01".into(),
                ..listed("d", "northwind.testnet", 1)
            },
            "due must be a date",
        ),
        (
            Bill {
                due: "next week".into(),
                ..listed("d", "northwind.testnet", 1)
            },
            "due must be a date",
        ),
        (
            Bill {
                label: " ".into(),
                ..listed("l", "northwind.testnet", 1)
            },
            "label is missing",
        ),
        (
            Bill {
                label: "x".repeat(281),
                ..listed("l", "northwind.testnet", 1)
            },
            "label is longer",
        ),
        (
            listed("p", "Not A Near Account", 1),
            "payee must be a NEAR account id",
        ),
        (
            Bill {
                chain: Some("solana".into()),
                ..listed("c", "0x000000000000000000000000000000000000dead", 1)
            },
            "chain must be",
        ),
        (
            Bill {
                chain: Some("base".into()),
                ..listed("c", "northwind.testnet", 1)
            },
            "payee must be a lowercase 0x address",
        ),
        (
            Bill {
                chain: Some("base".into()),
                ..listed("c", "0x000000000000000000000000000000000000DEAD", 1)
            },
            "payee must be a lowercase 0x address",
        ),
    ];
    for (b, want) in cases {
        let id = b.id.clone();
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut v = vault();
            as_owner(DAY);
            v.add_bill(b);
        }))
        .expect_err(&format!("bill {id:?} should be refused"));
        let msg = err.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(
            msg.contains(want),
            "bill {id:?}: wanted {want:?}, got {msg:?}"
        );
    }
}

#[test]
#[should_panic(expected = "50 bills are already listed")]
fn at_most_50_bills() {
    let mut v = vault();
    as_owner(DAY);
    for i in 0..51 {
        v.add_bill(listed(&format!("b{i}"), "northwind.testnet", 1));
    }
}

#[test]
fn a_listed_bill_still_goes_through_the_bands() {
    // Listing a bill gives the agent nothing extra: over the cap it can only propose.
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(listed("big", "northwind.testnet", 150));
    assert_eq!(
        v.check_payment(acc("northwind.testnet"), U128(150 * USDC))
            .band,
        Band::NeedsApproval
    );
}

#[test]
fn bills_can_repeat_yearly_with_a_category() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(Bill {
        yearly: true,
        category: Some("hosting".into()),
        label: "Domain renewal".into(),
        ..listed("domain", "northwind.testnet", 15)
    });
    let b = &v.get_bills()[0];
    assert!(b.yearly && !b.monthly && b.category.as_deref() == Some("hosting"));
}

#[test]
#[should_panic(expected = "monthly or yearly, not both")]
fn a_bill_cannot_repeat_both_ways() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(Bill {
        yearly: true,
        monthly: true,
        ..listed("x", "northwind.testnet", 1)
    });
}

#[test]
#[should_panic(expected = "category must be")]
fn bill_category_must_be_known() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(Bill {
        category: Some("yachts".into()),
        ..listed("x", "northwind.testnet", 1)
    });
}

fn payee(id: &str, kind: &str, keep_at: Option<u128>) -> Payee {
    Payee {
        account_id: acc(id),
        name: "Company card".into(),
        kind: kind.into(),
        keep_at: keep_at.map(|k| U128(k * USDC)),
        max_move: None,
        lending: false,
    }
}

#[test]
fn adding_a_payee_allowlists_it_and_removing_it_takes_it_off() {
    let mut v = vault();
    as_owner(DAY);
    v.add_payee(payee("card.kora.testnet", "card", Some(300)));
    assert!(v.get_policy().allowlist.contains(&acc("card.kora.testnet")));
    assert_eq!(v.get_payees()[0].keep_at, Some(U128(300 * USDC)));
    assert_eq!(
        v.check_payment(acc("card.kora.testnet"), U128(50 * USDC))
            .band,
        Band::RunsAlone
    );
    as_owner(DAY);
    v.remove_payee(acc("card.kora.testnet"));
    assert!(!v.get_policy().allowlist.contains(&acc("card.kora.testnet")));
    assert!(v.get_payees().is_empty());
}

#[test]
fn disallowing_or_blocking_a_payee_drops_its_name() {
    let mut v = vault();
    as_owner(DAY);
    v.add_payee(payee("card.kora.testnet", "card", None));
    v.add_payee(Payee {
        name: "Rent".into(),
        ..payee("rent.kora.testnet", "offramp", None)
    });
    v.update_policy(
        PolicyUpdate {
            disallow: vec![acc("card.kora.testnet")],
            block: vec![acc("rent.kora.testnet")],
            ..Default::default()
        },
        "cleanup".into(),
    );
    assert!(v.get_payees().is_empty());
}

#[test]
#[should_panic(expected = "only the owner can call this")]
fn agent_cannot_add_a_payee() {
    let mut v = vault();
    set_ctx(VAULT, DAY, 1);
    v.add_payee(payee("evil.testnet", "vendor", None));
}

#[test]
#[should_panic(expected = "cannot allow a blocklisted payee")]
fn blocklisted_account_cannot_become_a_payee() {
    let mut v = vault();
    as_owner(DAY);
    v.add_payee(payee("scam.testnet", "vendor", None));
}

#[test]
#[should_panic(expected = "only a card or your own wallet can be kept topped up")]
fn only_cards_and_own_wallets_get_topped_up() {
    let mut v = vault();
    as_owner(DAY);
    v.add_payee(payee("northwind.testnet", "vendor", Some(100)));
}

// ------------------------------------------------------------ cash buffer

fn as_callback(result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(VAULT))
            .predecessor_account_id(acc(VAULT))
            .block_timestamp(DAY)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn balance(usdc: u128) -> PromiseResult {
    PromiseResult::Successful(near_sdk::serde_json::to_vec(&U128(usdc * USDC)).unwrap())
}

fn buffered(min: u128) -> KeelVault {
    let mut v = vault();
    as_owner(DAY);
    v.update_policy(
        PolicyUpdate {
            min_balance: Some(U128(min * USDC)),
            ..Default::default()
        },
        "keep a buffer".into(),
    );
    v
}

#[test]
fn owner_sets_a_cash_buffer() {
    let v = buffered(900);
    assert_eq!(v.get_policy().min_balance, U128(900 * USDC));
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"min_balance\":\"900000000\"")));
}

#[test]
#[should_panic(expected = "only the owner can call this")]
fn agent_cannot_lower_the_buffer() {
    let mut v = buffered(900);
    set_ctx(VAULT, DAY, 1);
    v.update_policy(
        PolicyUpdate {
            min_balance: Some(U128(0)),
            ..Default::default()
        },
        "no buffer".into(),
    );
}

#[test]
fn payment_that_breaks_the_buffer_is_refused_and_undone() {
    let mut v = buffered(900);
    as_agent(DAY);
    let _ = pay_ref(&mut v, "northwind.testnet", 80 * USDC, "nw-nov");
    assert_eq!(v.get_policy().spent_today, U128(80 * USDC));
    // The vault holds 950: paying 80 would leave 870, under the 900 buffer.
    as_callback(balance(950));
    assert!(matches!(
        v.on_balance_checked(
            acc("northwind.testnet"),
            U128(80 * USDC),
            None,
            DAY,
            Some("nw-nov".into())
        ),
        PromiseOrValue::Value(false)
    ));
    assert_eq!(
        v.get_policy().spent_today,
        U128(0),
        "the daily spend is given back"
    );
    assert_eq!(
        v.bill_paid_at("nw-nov".into()),
        None,
        "the bill can be paid later"
    );
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("payment_refused") && l.contains("cash buffer")));
}

#[test]
fn payment_that_keeps_the_buffer_goes_ahead() {
    let mut v = buffered(900);
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 80 * USDC);
    as_callback(balance(1_000));
    assert!(matches!(
        v.on_balance_checked(acc("northwind.testnet"), U128(80 * USDC), None, DAY, None),
        PromiseOrValue::Promise(_)
    ));
    // Once the transfer is done, the reservation is released: a second 20 fits.
    as_callback(PromiseResult::Successful(vec![]));
    assert!(v.on_payment_done(
        None,
        acc("northwind.testnet"),
        U128(80 * USDC),
        Some(DAY),
        None,
        Some(true)
    ));
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 20 * USDC);
    as_callback(balance(920));
    assert!(matches!(
        v.on_balance_checked(acc("northwind.testnet"), U128(20 * USDC), None, DAY, None),
        PromiseOrValue::Promise(_)
    ));
}

#[test]
fn parallel_payments_cannot_slip_under_the_buffer_together() {
    // Each 60 fits on its own (1000 - 60 >= 900), but not both at once.
    let mut v = buffered(900);
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 60 * USDC);
    as_agent(DAY);
    let _ = pay(&mut v, "payroll.kora.testnet", 60 * USDC);
    as_callback(balance(1_000));
    assert!(matches!(
        v.on_balance_checked(acc("northwind.testnet"), U128(60 * USDC), None, DAY, None),
        PromiseOrValue::Value(false)
    ));
    as_callback(balance(1_000));
    assert!(
        matches!(
            v.on_balance_checked(
                acc("payroll.kora.testnet"),
                U128(60 * USDC),
                None,
                DAY,
                None
            ),
            PromiseOrValue::Promise(_)
        ),
        "once the first is undone, the second fits"
    );
}

#[test]
fn unreadable_balance_means_no_payment() {
    let mut v = buffered(900);
    as_agent(DAY);
    let _ = pay(&mut v, "northwind.testnet", 10 * USDC);
    as_callback(PromiseResult::Failed);
    assert!(matches!(
        v.on_balance_checked(acc("northwind.testnet"), U128(10 * USDC), None, DAY, None),
        PromiseOrValue::Value(false)
    ));
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("could not read the vault's balance")));
}

#[test]
fn owner_payments_ignore_the_buffer() {
    // The buffer binds Keel's agent; the owner can always withdraw.
    let mut v = buffered(900);
    as_owner(DAY);
    let _ = v.withdraw(acc("kora.testnet"), U128(500 * USDC), None);
}

#[test]
fn bills_can_be_critical() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(Bill {
        critical: true,
        ..listed("payroll", "payroll.kora.testnet", 50)
    });
    assert!(v.get_bills()[0].critical);
}

// ------------------------------------------------------------ idle cash

fn yield_payee(max: u128) -> Payee {
    Payee {
        account_id: acc("savings.kora.testnet"),
        name: "Treasury savings".into(),
        kind: "yield".into(),
        keep_at: None,
        max_move: Some(U128(max * USDC)),
        lending: false,
    }
}

#[test]
fn yield_destination_needs_a_per_move_limit() {
    let mut v = vault();
    as_owner(DAY);
    v.add_payee(yield_payee(200));
    assert_eq!(v.get_payees()[0].max_move, Some(U128(200 * USDC)));
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut v = vault();
        as_owner(DAY);
        v.add_payee(Payee {
            max_move: None,
            ..yield_payee(1)
        });
    }))
    .expect_err("a yield destination without max_move is refused");
    assert!(err
        .downcast_ref::<String>()
        .unwrap()
        .contains("needs max_move"));
}

#[test]
#[should_panic(expected = "only a yield destination has max_move")]
fn only_yield_destinations_have_max_move() {
    let mut v = vault();
    as_owner(DAY);
    v.add_payee(Payee {
        kind: "vendor".into(),
        ..yield_payee(10)
    });
}

#[test]
#[should_panic(expected = "over the most Keel may move to this yield destination at once")]
fn idle_move_over_the_limit_is_refused() {
    let mut v = buffered(100);
    as_owner(DAY);
    v.add_payee(yield_payee(50));
    as_agent(DAY);
    let _ = pay(&mut v, "savings.kora.testnet", 60 * USDC);
}

#[test]
#[should_panic(expected = "set a cash buffer before Keel moves idle cash")]
fn idle_move_needs_a_cash_buffer() {
    let mut v = vault();
    as_owner(DAY);
    v.add_payee(yield_payee(50));
    as_agent(DAY);
    let _ = pay(&mut v, "savings.kora.testnet", 10 * USDC);
}

#[test]
fn idle_move_within_the_limit_goes_through_the_buffer_check() {
    let mut v = buffered(100);
    as_owner(DAY);
    v.add_payee(yield_payee(50));
    as_agent(DAY);
    let _ = pay_ref(
        &mut v,
        "savings.kora.testnet",
        50 * USDC,
        "idle:savings.kora.testnet:1970-01-02",
    );
    // Holding 120 with a 100 buffer, moving 50 would leave 70: refused.
    as_callback(balance(120));
    assert!(matches!(
        v.on_balance_checked(
            acc("savings.kora.testnet"),
            U128(50 * USDC),
            None,
            DAY,
            Some("idle:savings.kora.testnet:1970-01-02".into())
        ),
        PromiseOrValue::Value(false)
    ));
}

// ------------------------------------------------------------ lending market (Rhea lending, formerly Burrow)

const MARKET: &str = "contract.burrow.testnet";

fn market_payee(max: u128) -> Payee {
    Payee {
        account_id: acc(MARKET),
        name: "Rhea lending".into(),
        kind: "yield".into(),
        keep_at: None,
        max_move: Some(U128(max * USDC)),
        lending: true,
    }
}

fn with_market() -> KeelVault {
    let mut v = buffered(100);
    as_owner(DAY);
    v.add_payee(market_payee(50));
    v
}

fn used(usdc: u128) -> PromiseResult {
    PromiseResult::Successful(near_sdk::serde_json::to_vec(&U128(usdc * USDC)).unwrap())
}

#[test]
#[should_panic(expected = "only a yield destination can be a lending market")]
fn only_yield_destinations_are_lending_markets() {
    let mut v = vault();
    as_owner(DAY);
    v.add_payee(Payee {
        kind: "vendor".into(),
        max_move: None,
        ..market_payee(1)
    });
}

#[test]
fn deposit_into_the_market_is_credited_to_the_vault() {
    let mut v = with_market();
    as_agent(DAY);
    let _ = pay_ref(
        &mut v,
        MARKET,
        50 * USDC,
        "idle:contract.burrow.testnet:1970-01-02",
    );
    as_callback(balance(300));
    assert!(matches!(
        v.on_balance_checked(
            acc(MARKET),
            U128(50 * USDC),
            None,
            DAY,
            Some("idle:contract.burrow.testnet:1970-01-02".into())
        ),
        PromiseOrValue::Promise(_)
    ));
    // The market kept all 50.
    as_callback(used(50));
    assert!(v.on_deposit_done(
        None,
        acc(MARKET),
        U128(50 * USDC),
        Some(DAY),
        Some("idle:contract.burrow.testnet:1970-01-02".into()),
        Some(true)
    ));
    assert!(get_logs().iter().any(|l| l.contains("yield_deposited")));
    assert!(v
        .bill_paid_at("idle:contract.burrow.testnet:1970-01-02".into())
        .is_some());
    assert_eq!(v.get_policy().spent_today, U128(50 * USDC));
}

#[test]
fn deposit_the_market_refused_is_undone() {
    let mut v = with_market();
    as_agent(DAY);
    let _ = pay_ref(
        &mut v,
        MARKET,
        50 * USDC,
        "idle:contract.burrow.testnet:1970-01-02",
    );
    as_callback(used(0));
    assert!(!v.on_deposit_done(
        None,
        acc(MARKET),
        U128(50 * USDC),
        Some(DAY),
        Some("idle:contract.burrow.testnet:1970-01-02".into()),
        Some(true)
    ));
    assert_eq!(
        v.bill_paid_at("idle:contract.burrow.testnet:1970-01-02".into()),
        None,
        "it can be tried again"
    );
    assert_eq!(v.get_policy().spent_today, U128(0));
    assert!(get_logs().iter().any(|l| l.contains("payment_failed")));
}

#[test]
fn partial_deposit_counts_only_what_the_market_kept() {
    let mut v = with_market();
    as_agent(DAY);
    let _ = pay(&mut v, MARKET, 50 * USDC);
    as_callback(used(20));
    assert!(v.on_deposit_done(
        None,
        acc(MARKET),
        U128(50 * USDC),
        Some(DAY),
        None,
        Some(true)
    ));
    assert_eq!(v.get_policy().spent_today, U128(20 * USDC));
}

#[test]
fn agent_can_bring_savings_home() {
    let mut v = with_market();
    as_agent(DAY);
    let _ = v.recall_from_yield(acc(MARKET), Some(U128(30 * USDC * 1_000_000_000_000)));
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("yield_recall_started")));
    as_callback(PromiseResult::Successful(vec![]));
    assert!(v.on_recall_done(acc(MARKET), None));
    assert!(get_logs().iter().any(|l| l.contains("yield_recalled")));
}

#[test]
fn owner_can_bring_savings_home_even_while_paused() {
    let mut v = with_market();
    as_owner(DAY);
    v.pause();
    as_owner(DAY);
    let _ = v.recall_from_yield(acc(MARKET), None);
}

#[test]
#[should_panic(expected = "only the agent can call this")]
fn stranger_cannot_recall() {
    let mut v = with_market();
    set_ctx("mallory.testnet", DAY, 0);
    let _ = v.recall_from_yield(acc(MARKET), None);
}

#[test]
#[should_panic(expected = "not one of the vault's lending markets")]
fn recall_only_from_an_approved_market() {
    let mut v = with_market();
    as_agent(DAY);
    let _ = v.recall_from_yield(acc("evil-market.testnet"), None);
}

#[test]
#[should_panic(expected = "not one of the vault's lending markets")]
fn a_plain_yield_destination_is_not_a_market() {
    let mut v = buffered(100);
    as_owner(DAY);
    v.add_payee(yield_payee(50));
    as_agent(DAY);
    let _ = v.recall_from_yield(acc("savings.kora.testnet"), None);
}

// ------------------------------------------------------------ owner transfer

const TEAM: &str = "team.sputnikv2.testnet";

/// The owner offers the vault to TEAM and TEAM accepts; the factory answers `factory_ok`.
fn hand_over(v: &mut KeelVault, factory_ok: bool) -> bool {
    as_owner(DAY);
    v.transfer_owner(acc(TEAM));
    set_ctx(TEAM, DAY, 1);
    let _ = v.accept_owner();
    as_callback(if factory_ok {
        PromiseResult::Successful(vec![])
    } else {
        PromiseResult::Failed
    });
    v.on_owner_recorded(acc(TEAM))
}

#[test]
fn owner_hands_the_vault_to_a_multisig_once_it_accepts_and_the_factory_records_it() {
    let mut v = vault();
    as_owner(DAY);
    v.transfer_owner(acc(TEAM));
    assert_eq!(
        v.get_policy().owner_id,
        acc("kora.testnet"),
        "an offer changes nothing"
    );
    assert_eq!(v.get_policy().pending_owner, Some(acc(TEAM)));
    set_ctx(TEAM, DAY, 1);
    let _ = v.accept_owner();
    assert_eq!(
        v.get_policy().owner_id,
        acc("kora.testnet"),
        "nothing changes before the factory answers"
    );
    as_callback(PromiseResult::Successful(vec![]));
    assert!(v.on_owner_recorded(acc(TEAM)));
    assert_eq!(v.get_policy().owner_id, acc(TEAM));
    assert_eq!(v.get_policy().pending_owner, None);
    set_ctx(TEAM, DAY, 1);
    v.pause();
    assert!(v.get_policy().paused);
}

#[test]
fn owner_stays_if_the_factory_refuses_and_the_offer_stands() {
    let mut v = vault();
    assert!(!hand_over(&mut v, false));
    assert_eq!(v.get_policy().owner_id, acc("kora.testnet"));
    assert_eq!(v.get_policy().pending_owner, Some(acc(TEAM)));
    // The owner keeps control and can withdraw the offer.
    as_owner(DAY);
    v.cancel_owner_transfer();
    assert_eq!(v.get_policy().pending_owner, None);
}

#[test]
#[should_panic(expected = "this account was not offered the vault")]
fn nobody_can_take_a_vault_that_was_not_offered() {
    let mut v = vault();
    set_ctx("mallory.testnet", DAY, 1);
    let _ = v.accept_owner();
}

#[test]
#[should_panic(expected = "this account was not offered the vault")]
fn a_stranger_cannot_accept_someone_elses_offer() {
    let mut v = vault();
    as_owner(DAY);
    v.transfer_owner(acc(TEAM));
    set_ctx("mallory.testnet", DAY, 1);
    let _ = v.accept_owner();
}

#[test]
#[should_panic(expected = "this account was not offered the vault")]
fn a_cancelled_offer_cannot_be_accepted() {
    let mut v = vault();
    as_owner(DAY);
    v.transfer_owner(acc(TEAM));
    v.cancel_owner_transfer();
    set_ctx(TEAM, DAY, 1);
    let _ = v.accept_owner();
}

#[test]
#[should_panic(expected = "an ownership change is being recorded")]
fn the_owner_cannot_cancel_while_an_acceptance_is_in_flight() {
    let mut v = vault();
    as_owner(DAY);
    v.transfer_owner(acc(TEAM));
    set_ctx(TEAM, DAY, 1);
    let _ = v.accept_owner();
    as_owner(DAY);
    v.cancel_owner_transfer();
}

#[test]
#[should_panic(expected = "an ownership change is being recorded")]
fn an_offer_cannot_be_accepted_twice_at_once() {
    let mut v = vault();
    as_owner(DAY);
    v.transfer_owner(acc(TEAM));
    set_ctx(TEAM, DAY, 1);
    let _ = v.accept_owner();
    let _ = v.accept_owner();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn accepting_needs_a_full_access_signature() {
    let mut v = vault();
    as_owner(DAY);
    v.transfer_owner(acc(TEAM));
    set_ctx(TEAM, DAY, 0);
    let _ = v.accept_owner();
}

#[test]
#[should_panic(expected = "a vault cannot own itself")]
fn a_vault_cannot_be_given_to_itself() {
    let mut v = vault();
    as_owner(DAY);
    v.transfer_owner(acc(VAULT));
}

#[test]
#[should_panic(expected = "the factory cannot own a vault")]
fn a_vault_cannot_be_given_to_the_factory() {
    let mut v = vault();
    as_owner(DAY);
    v.transfer_owner(acc("kora.testnet"));
}

#[test]
#[should_panic(expected = "only the owner can call this")]
fn agent_cannot_offer_ownership() {
    let mut v = vault();
    set_ctx(VAULT, DAY, 1);
    v.transfer_owner(acc("evil.testnet"));
}

#[test]
#[should_panic(expected = "only the owner can call this")]
fn agent_cannot_cancel_an_offer() {
    let mut v = vault();
    as_owner(DAY);
    v.transfer_owner(acc(TEAM));
    set_ctx(VAULT, DAY, 1);
    v.cancel_owner_transfer();
}

#[test]
#[should_panic(expected = "only the owner can call this")]
fn the_old_owner_loses_control_after_the_transfer() {
    let mut v = vault();
    assert!(hand_over(&mut v, true));
    as_owner(DAY);
    v.pause();
}

#[test]
#[should_panic(expected = "this account was not offered the vault")]
fn an_accepted_offer_cannot_be_replayed() {
    let mut v = vault();
    assert!(hand_over(&mut v, true));
    set_ctx(TEAM, DAY, 1);
    let _ = v.accept_owner();
}

#[test]
#[should_panic]
fn strangers_cannot_call_the_owner_callback() {
    let mut v = vault();
    set_ctx("mallory.testnet", DAY, 0);
    v.on_owner_recorded(acc("mallory.testnet"));
}

// --------------------------------- every agent payment names a bill the owner set

const HOUR: u64 = DAY / 24;

fn refused(f: impl FnOnce()) -> String {
    let err =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("should be refused");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

#[test]
#[should_panic(expected = "every agent payment needs a bill_ref")]
fn agent_payment_without_a_bill_ref_is_refused() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None, None, None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: no such bill")]
fn agent_payment_with_a_made_up_bill_ref_is_refused() {
    // A stolen key paying an approved payee under the caps, with an invented reason.
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(
        acc("northwind.testnet"),
        U128(10 * USDC),
        None,
        Some("invented-1".into()),
        None,
    );
}

#[test]
#[should_panic(expected = "payment does not match the owner's bill")]
fn agent_cannot_pay_a_bill_to_another_payee() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(listed("nw", "northwind.testnet", 40));
    as_agent(DAY);
    // payroll.kora.testnet is allowlisted, but the bill is Northwind's.
    let _ = v.execute_payment(
        acc("payroll.kora.testnet"),
        U128(40 * USDC),
        None,
        Some("nw".into()),
        None,
    );
}

#[test]
#[should_panic(expected = "payment does not match the owner's bill")]
fn agent_cannot_pay_a_bill_with_another_amount() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(listed("nw", "northwind.testnet", 40));
    as_agent(DAY);
    let _ = v.execute_payment(
        acc("northwind.testnet"),
        U128(90 * USDC),
        None,
        Some("nw".into()),
        None,
    );
}

#[test]
#[should_panic(expected = "top-ups only go to a card or own wallet with a target")]
fn top_up_to_a_vendor_is_refused() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(
        acc("northwind.testnet"),
        U128(10 * USDC),
        None,
        Some("top:northwind.testnet:1970-01-02".into()),
        None,
    );
}

#[test]
#[should_panic(expected = "idle cash only goes to a yield destination")]
fn idle_move_to_a_non_yield_payee_is_refused() {
    let mut v = buffered(10);
    as_agent(DAY);
    let _ = v.execute_payment(
        acc("northwind.testnet"),
        U128(10 * USDC),
        None,
        Some("idle:northwind.testnet:1970-01-02".into()),
        None,
    );
}

#[test]
fn top_up_rules() {
    let mut v = vault();
    as_owner(DAY);
    v.add_payee(payee("card.kora.testnet", "card", Some(50)));
    as_agent(DAY);
    // Today's top-up up to the target is paid once.
    let _ = v.execute_payment(
        acc("card.kora.testnet"),
        U128(30 * USDC),
        None,
        Some("top:card.kora.testnet:1970-01-02".into()),
        None,
    );
    let cases: [(&str, u128, &str); 5] = [
        ("top:card.kora.testnet:1970-01-02", 10, "already paid"),
        // Yesterday's date is refused too: one top-up per wallet per calendar day.
        (
            "top:card.kora.testnet:1970-01-01",
            10,
            "must be dated today",
        ),
        (
            "top:card.kora.testnet:1971-03-01",
            10,
            "must be dated today",
        ),
        (
            "top:northwind.testnet:1970-01-01",
            10,
            "names another payee",
        ),
        (
            "top:card.kora.testnet:1970-01-02",
            60,
            "more than the wallet's target",
        ),
    ];
    for (r, amount, why) in cases {
        let msg = refused(|| {
            as_agent(DAY);
            let _ = v.execute_payment(
                acc("card.kora.testnet"),
                U128(amount * USDC),
                None,
                Some(r.into()),
                None,
            );
        });
        assert!(msg.contains(why), "{r}: {msg}");
    }
}

#[test]
fn repeating_bills_are_paid_only_for_their_own_periods() {
    let mut v = vault();
    as_owner(NOV9);
    v.add_bill(Bill {
        monthly: true,
        due: "2026-10-15".into(),
        ..listed("rent", "northwind.testnet", 40)
    });
    v.add_bill(Bill {
        yearly: true,
        due: "2026-11-01".into(),
        ..listed("domain", "northwind.testnet", 15)
    });
    v.add_bill(listed("once", "northwind.testnet", 20));
    as_agent(NOV9);
    let _ = v.execute_payment(
        acc("northwind.testnet"),
        U128(40 * USDC),
        None,
        Some("rent:2026-11".into()),
        None,
    );
    let _ = v.execute_payment(
        acc("northwind.testnet"),
        U128(15 * USDC),
        None,
        Some("domain:2026".into()),
        None,
    );
    for r in [
        "rent:2027-06",
        "rent:2026-09",
        "rent",
        "rent:2026-11-01",
        "domain:2028",
        "domain:2025",
        "once:2026-11",
    ] {
        let msg = refused(|| {
            as_agent(NOV9);
            let amount = if r.starts_with("rent") {
                40
            } else if r.starts_with("domain") {
                15
            } else {
                20
            };
            let _ = v.execute_payment(
                acc("northwind.testnet"),
                U128(amount * USDC),
                None,
                Some(r.into()),
                None,
            );
        });
        assert!(msg.contains("period does not fit the bill"), "{r}: {msg}");
    }
}

#[test]
#[should_panic(expected = "reserved for top-ups and idle cash")]
fn bill_ids_top_and_idle_are_reserved() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(listed("top", "northwind.testnet", 1));
}

#[test]
#[should_panic(expected = "payment does not match the owner's bill")]
fn a_cross_chain_bill_cannot_be_paid_on_near() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(Bill {
        chain: Some("base".into()),
        ..listed("b", PAYEE_EVM, 5)
    });
    v.add_payee(payee("northwind.testnet", "vendor", None));
    as_agent(DAY);
    let _ = v.execute_payment(
        acc("northwind.testnet"),
        U128(5 * USDC),
        None,
        Some("b".into()),
        None,
    );
}

// ------------------------------------------- a waiting proposal cannot be swapped

#[test]
#[should_panic(expected = "every agent proposal needs a bill_ref")]
fn proposal_without_a_bill_ref_is_refused() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(
        acc("atlas.testnet"),
        U128(5 * USDC),
        None,
        "x".into(),
        None,
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "Keel Vault refused: no such bill")]
fn proposal_for_a_made_up_bill_is_refused() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(
        acc("atlas.testnet"),
        U128(5 * USDC),
        None,
        "x".into(),
        None,
        None,
        Some("invented".into()),
    );
}

#[test]
fn a_waiting_near_proposal_cannot_be_swapped_for_another_payee_or_amount() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(listed("atlas-inv", "atlas.testnet", 50));
    as_agent(DAY);
    v.propose_payment(
        acc("atlas.testnet"),
        U128(50 * USDC),
        None,
        "new payee".into(),
        None,
        None,
        Some("atlas-inv".into()),
    );
    for (to, amount) in [("attacker.testnet", 50), ("atlas.testnet", 500)] {
        let msg = refused(|| {
            as_agent(DAY);
            v.propose_payment(
                acc(to),
                U128(amount * USDC),
                None,
                "swap".into(),
                None,
                None,
                Some("atlas-inv".into()),
            );
        });
        assert!(
            msg.contains("payment does not match the owner's bill"),
            "{to} {amount}: {msg}"
        );
    }
    assert_eq!(
        v.get_proposal(1).unwrap().receiver_id,
        acc("atlas.testnet"),
        "the owner's proposal is untouched"
    );
    assert_eq!(v.pending_count(), 1);
}

#[test]
fn an_evm_proposal_must_pay_the_bills_own_address_on_its_chain() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(Bill {
        chain: Some("base".into()),
        ..listed("b", PAYEE_EVM, 5)
    });
    let other = "0x00000000000000000000000000000000000000cc";
    let cases: [(EvmTransfer, u128, &str); 3] = [
        (
            EvmTransfer {
                to: other.into(),
                ..evm_transfer()
            },
            5,
            "payment does not match",
        ),
        (evm_transfer(), 6, "payment does not match"),
        (
            EvmTransfer {
                chain_id: 421614,
                token: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d".into(),
                ..evm_transfer()
            },
            5,
            "the bill is on another chain",
        ),
    ];
    for (e, amount, why) in cases {
        let msg = refused(|| {
            as_agent(DAY);
            let to = e.to.clone();
            v.propose_payment(
                acc(&to),
                U128(amount * USDC),
                None,
                "x".into(),
                None,
                Some(e),
                Some("b".into()),
            );
        });
        assert!(msg.contains(why), "{msg}");
    }
}

#[test]
#[should_panic(expected = "payment does not match the owner's bill")]
fn a_near_bill_cannot_be_turned_into_an_intents_deposit() {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(listed("nw", "northwind.testnet", 40));
    as_agent(DAY);
    v.propose_payment(
        acc(DEPOSIT),
        U128(40 * USDC),
        None,
        "x".into(),
        Some(DAY / MS + 600_000),
        None,
        Some("nw".into()),
    );
}

// ------------------------------------------------------- rolling 24-hour cap

#[test]
fn daily_cap_is_a_rolling_24_hours_not_a_calendar_day() {
    let mut v = vault();
    // 500 spent at 23:00 UTC.
    as_agent(2 * DAY - HOUR);
    for _ in 0..5 {
        let _ = pay(&mut v, "northwind.testnet", 100 * USDC);
    }
    // At 01:00 the next calendar day, the cap is still used up.
    as_agent(2 * DAY + HOUR);
    assert_eq!(v.get_policy().spent_today, U128(500 * USDC));
    let msg = refused(|| {
        as_agent(2 * DAY + HOUR);
        let _ = pay(&mut v, "northwind.testnet", 1 * USDC);
    });
    assert!(msg.contains("daily cap"), "{msg}");
    // 24 hours after the payments, it is free again.
    as_agent(3 * DAY - HOUR + 1);
    let _ = pay(&mut v, "northwind.testnet", 100 * USDC);
    assert_eq!(v.get_policy().spent_today, U128(100 * USDC));
}

#[test]
fn a_failed_payment_is_given_back_inside_the_window() {
    let mut v = vault();
    as_agent(DAY + HOUR);
    let _ = pay(&mut v, "northwind.testnet", 70 * USDC);
    as_agent(DAY + 2 * HOUR);
    let _ = pay(&mut v, "northwind.testnet", 30 * USDC);
    as_callback(PromiseResult::Failed);
    v.on_payment_done(
        None,
        acc("northwind.testnet"),
        U128(70 * USDC),
        Some(DAY + HOUR),
        None,
        None,
    );
    as_agent(DAY + 3 * HOUR);
    assert_eq!(v.get_policy().spent_today, U128(30 * USDC));
}

// ------------------------------------------- EVM bills paid alone under auto_cap

fn auto_vault(auto: Option<u128>) -> KeelVault {
    let mut v = vault();
    as_owner(DAY);
    v.set_evm_route(
        84532,
        Some(EvmRoute {
            auto_cap: auto.map(|a| U128(a * USDC)),
            ..default_evm_routes()[0].clone()
        }),
    );
    v.add_bill(Bill {
        chain: Some("base".into()),
        ..listed("b", PAYEE_EVM, 5)
    });
    v.update_policy(
        PolicyUpdate {
            allow: vec![acc(PAYEE_EVM)],
            ..Default::default()
        },
        "Base vendor".into(),
    );
    v
}

fn evm_pay(v: &mut KeelVault, amount: u128) {
    as_agent(DAY);
    let _ = v.execute_payment(
        acc(PAYEE_EVM),
        U128(amount * USDC),
        None,
        Some("b".into()),
        Some(evm_transfer()),
    );
}

#[test]
fn an_allowlisted_evm_bill_under_the_auto_cap_is_signed_at_once() {
    let mut v = auto_vault(Some(10));
    evm_pay(&mut v, 5);
    let p = v.get_proposal(1).unwrap();
    assert_eq!(p.status, ProposalStatus::Signing, "no owner vote needed");
    assert_eq!(p.evm_amount, Some(U128(5 * USDC)));
    assert_eq!(
        v.get_policy().spent_today,
        U128(5 * USDC),
        "counts against the daily cap"
    );
    assert_eq!(v.pending_count(), 0);
    assert!(v.bill_paid_at("b".into()).is_some());
}

#[test]
#[should_panic(expected = "over this chain's auto cap")]
fn an_evm_bill_over_the_auto_cap_must_be_proposed() {
    let mut v = auto_vault(Some(4));
    evm_pay(&mut v, 5);
}

#[test]
#[should_panic(expected = "over this chain's auto cap")]
fn without_an_auto_cap_every_evm_bill_waits_for_the_owner() {
    let mut v = auto_vault(None);
    evm_pay(&mut v, 5);
}

#[test]
#[should_panic(expected = "Keel Vault refused: new payee")]
fn an_evm_payee_not_on_the_allowlist_is_never_paid_alone() {
    let mut v = auto_vault(Some(10));
    as_owner(DAY);
    v.update_policy(
        PolicyUpdate {
            disallow: vec![acc(PAYEE_EVM)],
            ..Default::default()
        },
        "x".into(),
    );
    evm_pay(&mut v, 5);
}

#[test]
#[should_panic(expected = "auto_cap cannot be above the per-payment cap")]
fn auto_cap_stays_under_the_per_payment_cap() {
    let _ = auto_vault(Some(101));
}

#[test]
fn civil_dates_match_the_calendar() {
    assert_eq!(civil_date(0), "1970-01-01");
    assert_eq!(civil_date(20_766), "2026-11-09");
    assert_eq!(civil_date(11_016), "2000-02-29");
    assert_eq!(civil_date(20_818), "2026-12-31");
}

// ------------------------------- NEAR Intents proposals are bounded on chain

/// A cross-chain bill of 5 USDC on Base.
fn intents_vault() -> KeelVault {
    let mut v = vault();
    as_owner(DAY);
    v.add_bill(Bill {
        chain: Some("base".into()),
        ..listed("base-inv", PAYEE_EVM, 5)
    });
    v
}

fn intents_propose(v: &mut KeelVault, receiver: &str, amount: u128) -> u64 {
    as_agent(DAY);
    v.propose_payment(
        acc(receiver),
        U128(amount),
        None,
        "quote".into(),
        Some(DAY / MS + 600_000),
        None,
        Some("base-inv".into()),
    )
}

#[test]
fn an_intents_proposal_within_3_percent_to_a_deposit_address_is_filed() {
    let mut v = intents_vault();
    // 5 USDC plus 3% is 5.15 USDC: the most a quote may cost.
    let id = intents_propose(&mut v, DEPOSIT, 5_150_000);
    assert_eq!(v.get_proposal(id).unwrap().status, ProposalStatus::Pending);
}

#[test]
#[should_panic(expected = "a cross-chain proposal must pay a 1Click deposit address")]
fn an_intents_proposal_to_a_named_account_is_refused() {
    let mut v = intents_vault();
    intents_propose(&mut v, "attacker.testnet", 5 * USDC);
}

#[test]
#[should_panic(expected = "a cross-chain proposal must pay a 1Click deposit address")]
fn an_intents_proposal_to_an_uppercase_or_short_hex_account_is_refused() {
    let mut v = intents_vault();
    intents_propose(&mut v, &"a1".repeat(31), 5 * USDC);
}

#[test]
#[should_panic(expected = "more than 3% over the bill")]
fn an_intents_proposal_more_than_3_percent_over_the_bill_is_refused() {
    let mut v = intents_vault();
    intents_propose(&mut v, DEPOSIT, 5_150_001);
}

#[test]
fn a_swapped_intents_proposal_stays_inside_the_same_bounds() {
    let mut v = intents_vault();
    intents_propose(&mut v, DEPOSIT, 5 * USDC);
    // A stolen key re-proposing the bill can only name another deposit address
    // within 3%; an ordinary account or a larger amount is refused.
    for (to, amount) in [("attacker.testnet", 5 * USDC), (DEPOSIT2, 50 * USDC)] {
        let msg = refused(|| {
            intents_propose(&mut v, to, amount);
        });
        assert!(
            msg.contains("1Click deposit address") || msg.contains("3% over"),
            "{to}: {msg}"
        );
    }
    assert_eq!(v.get_proposal(1).unwrap().amount, U128(5 * USDC));
}

#[test]
fn a_failed_signature_gives_back_its_share_of_the_cap() {
    let mut v = auto_vault(Some(10));
    evm_pay(&mut v, 5);
    assert_eq!(v.get_policy().spent_today, U128(5 * USDC));
    as_callback(PromiseResult::Failed);
    assert!(v.on_evm_signed(1).is_none());
    as_agent(DAY);
    assert_eq!(
        v.get_policy().spent_today,
        U128(0),
        "nothing was signed, so nothing counts"
    );
    assert!(
        v.bill_paid_at("b".into()).is_none(),
        "and the bill can be paid again"
    );
}
