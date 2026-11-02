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
    KeelVault::new(
        acc("kora.testnet"),
        pk(AGENT_KEY),
        acc("usdc.testnet"),
    )
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(1 * USDC), None);
}

#[test]
fn agent_pays_allowlisted_payee_under_cap() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None);
    assert_eq!(v.get_policy().spent_today, U128(80 * USDC));
    assert!(get_logs().iter().any(|l| l.contains("payment_started")));
}

#[test]
#[should_panic(expected = "Keel Vault refused: over the per-payment cap")]
fn refuses_payment_over_cap() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(101 * USDC), None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: new payee")]
fn refuses_new_payee() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("stranger.testnet"), U128(10 * USDC), None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: payee is on the blocklist")]
fn refuses_blocklisted_payee() {
    // The attack demo: even if the agent is tricked, the vault says no.
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("scam.testnet"), U128(1 * USDC), None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: daily cap")]
fn refuses_after_daily_cap() {
    let mut v = vault();
    as_agent(DAY);
    for _ in 0..5 {
        let _ = v.execute_payment(acc("northwind.testnet"), U128(100 * USDC), None);
    }
    let _ = v.execute_payment(acc("northwind.testnet"), U128(1 * USDC), None);
}

#[test]
fn daily_cap_resets_next_day() {
    let mut v = vault();
    as_agent(DAY);
    for _ in 0..5 {
        let _ = v.execute_payment(acc("northwind.testnet"), U128(100 * USDC), None);
    }
    as_agent(2 * DAY + 1);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(100 * USDC), None);
    assert_eq!(v.get_policy().spent_today, U128(100 * USDC));
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn only_agent_can_execute() {
    let mut v = vault();
    set_ctx("someone.testnet", DAY, 0);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None);
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: vault is paused")]
fn paused_vault_refuses_payment() {
    let mut v = vault();
    as_owner(DAY);
    v.pause();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None);
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
    let id = v.propose_payment(
        acc("payroll.kora.testnet"),
        U128(8_000 * USDC),
        None,
        "Payroll short 6,920 for Nov 7".into(),
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
    v.propose_payment(acc("stranger.testnet"), U128(50 * USDC), None, "new vendor".into());
    as_owner(DAY);
    v.reject(1);
    assert_eq!(v.get_proposal(1).unwrap().status, ProposalStatus::Rejected);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the owner can call this")]
fn agent_cannot_approve_its_own_proposal() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("stranger.testnet"), U128(50 * USDC), None, "new vendor".into());
    as_agent_with_deposit(DAY, 1);
    let _ = v.approve(1);
}

#[test]
#[should_panic(expected = "Keel Vault refused: payee is on the blocklist")]
fn blocklisted_payee_is_never_proposed() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("scam.testnet"), U128(950 * USDC), None, "urgent invoice".into());
}

#[test]
#[should_panic(expected = "Keel Vault refused: payee is on the blocklist")]
fn approval_refused_if_payee_blocked_later() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("stranger.testnet"), U128(50 * USDC), None, "new vendor".into());
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn old_agent_key_refused_after_rotation() {
    let mut v = vault();
    as_owner(DAY);
    let _ = v.set_agent_key(pk(OTHER_KEY));
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None);
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None);
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn agent_key_from_another_account_is_refused() {
    let mut v = vault();
    ctx("agent.kora.testnet", AGENT_KEY, DAY, 0);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None);
}

#[test]
fn failed_transfer_is_refunded_to_daily_cap() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(100 * USDC), None);
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
    let ok = v.on_payment_done(None, acc("northwind.testnet"), U128(100 * USDC), Some(1));
    assert!(!ok);
    assert_eq!(v.get_policy().spent_today, U128(0));
    assert!(get_logs().iter().any(|l| l.contains("payment_failed")));
}

#[test]
fn approved_proposal_marked_executed_on_success() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("payroll.kora.testnet"), U128(8_000 * USDC), None, "payroll".into());
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
    assert!(v.on_payment_done(Some(1), acc("payroll.kora.testnet"), U128(8_000 * USDC), None));
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(60 * USDC), None);
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
    v.on_payment_done(None, acc("kora.testnet"), U128(500 * USDC), None);
    assert_eq!(v.get_policy().spent_today, U128(60 * USDC));
}
