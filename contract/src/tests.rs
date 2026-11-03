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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(1 * USDC), None, None);
}

#[test]
fn agent_pays_allowlisted_payee_under_cap() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, None);
    assert_eq!(v.get_policy().spent_today, U128(80 * USDC));
    assert!(get_logs().iter().any(|l| l.contains("payment_started")));
}

#[test]
#[should_panic(expected = "Keel Vault refused: over the per-payment cap")]
fn refuses_payment_over_cap() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(101 * USDC), None, None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: new payee")]
fn refuses_new_payee() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("stranger.testnet"), U128(10 * USDC), None, None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: payee is on the blocklist")]
fn refuses_blocklisted_payee() {
    // The attack demo: even if the agent is tricked, the vault says no.
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("scam.testnet"), U128(1 * USDC), None, None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: daily cap")]
fn refuses_after_daily_cap() {
    let mut v = vault();
    as_agent(DAY);
    for _ in 0..5 {
        let _ = v.execute_payment(acc("northwind.testnet"), U128(100 * USDC), None, None);
    }
    let _ = v.execute_payment(acc("northwind.testnet"), U128(1 * USDC), None, None);
}

#[test]
fn daily_cap_resets_next_day() {
    let mut v = vault();
    as_agent(DAY);
    for _ in 0..5 {
        let _ = v.execute_payment(acc("northwind.testnet"), U128(100 * USDC), None, None);
    }
    as_agent(2 * DAY + 1);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(100 * USDC), None, None);
    assert_eq!(v.get_policy().spent_today, U128(100 * USDC));
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn only_agent_can_execute() {
    let mut v = vault();
    set_ctx("someone.testnet", DAY, 0);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None, None);
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None, None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: vault is paused")]
fn paused_vault_refuses_payment() {
    let mut v = vault();
    as_owner(DAY);
    v.pause();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None, None);
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
        None, None, None,
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
    v.propose_payment(acc("stranger.testnet"), U128(50 * USDC), None, "new vendor".into(), None, None, None);
    as_owner(DAY);
    v.reject(1);
    assert_eq!(v.get_proposal(1).unwrap().status, ProposalStatus::Rejected);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the owner can call this")]
fn agent_cannot_approve_its_own_proposal() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("stranger.testnet"), U128(50 * USDC), None, "new vendor".into(), None, None, None);
    as_agent_with_deposit(DAY, 1);
    let _ = v.approve(1);
}

#[test]
#[should_panic(expected = "Keel Vault refused: payee is on the blocklist")]
fn blocklisted_payee_is_never_proposed() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("scam.testnet"), U128(950 * USDC), None, "urgent invoice".into(), None, None, None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: payee is on the blocklist")]
fn approval_refused_if_payee_blocked_later() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("stranger.testnet"), U128(50 * USDC), None, "new vendor".into(), None, None, None);
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None, None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn old_agent_key_refused_after_rotation() {
    let mut v = vault();
    as_owner(DAY);
    let _ = v.set_agent_key(pk(OTHER_KEY));
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None, None);
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None, None);
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None, None);
}

#[test]
#[should_panic(expected = "Keel Vault refused: only the agent can call this")]
fn agent_key_from_another_account_is_refused() {
    let mut v = vault();
    ctx("agent.kora.testnet", AGENT_KEY, DAY, 0);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(10 * USDC), None, None);
}

#[test]
fn failed_transfer_is_refunded_to_daily_cap() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(100 * USDC), None, None);
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
    let ok = v.on_payment_done(None, acc("northwind.testnet"), U128(100 * USDC), Some(1), None);
    assert!(!ok);
    assert_eq!(v.get_policy().spent_today, U128(0));
    assert!(get_logs().iter().any(|l| l.contains("payment_failed")));
}

#[test]
fn approved_proposal_marked_executed_on_success() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("payroll.kora.testnet"), U128(8_000 * USDC), None, "payroll".into(), None, None, None);
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
    assert!(v.on_payment_done(Some(1), acc("payroll.kora.testnet"), U128(8_000 * USDC), None, None));
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(60 * USDC), None, None);
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
    v.on_payment_done(None, acc("kora.testnet"), U128(500 * USDC), None, None);
    assert_eq!(v.get_policy().spent_today, U128(60 * USDC));
}

const MS: u64 = 1_000_000; // block timestamps are in nanoseconds

#[test]
fn intents_offer_can_be_approved_before_it_expires() {
    let mut v = vault();
    as_agent(DAY);
    let deadline = DAY / MS + 10 * 60 * 1000; // ten minutes from now, in ms
    v.propose_payment(acc("deposit.1click.near"), U128(5 * USDC), None, "Move 5 USDC to Base via NEAR Intents".into(), Some(deadline), None, None);
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
    v.propose_payment(acc("deposit.1click.near"), U128(5 * USDC), None, "Move 5 USDC to Base".into(), Some(deadline), None, None);
    as_owner(DAY + 11 * 60 * 1_000_000_000);
    let _ = v.approve(1);
}

#[test]
#[should_panic(expected = "Keel Vault refused: the offer has already expired")]
fn cannot_propose_an_offer_that_already_expired() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("deposit.1click.near"), U128(5 * USDC), None, "stale".into(), Some(DAY / MS - 1), None, None);
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
    v.propose_payment(acc(&to), U128(5 * USDC), None, "Pay Base invoice".into(), Some(DAY / MS + 30 * 60 * 1000), Some(e), None)
}

#[test]
fn testnet_vault_starts_with_the_base_sepolia_route() {
    let v = vault();
    let r = v.get_evm_route();
    let ids: Vec<u64> = r["routes"].as_array().unwrap().iter().map(|x| x["chain_id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![84532, 11155111, 421614, 11155420], "Base, Ethereum, Arbitrum and Optimism Sepolia");
    assert_eq!(r["routes"][0]["token"], BASE_USDC);
    assert_eq!(r["mpc_id"], "v1.signer-prod.testnet");
    assert_eq!(r["path"], "evm");
}

#[test]
fn signing_hash_matches_an_independent_encoder() {
    // keccak256 of the unsigned EIP-1559 tx, from viem 2.57 serializeTransaction.
    as_owner(DAY);
    let h = evm_transfer().signing_hash(5 * USDC);
    assert_eq!(evm::hex_encode(&h), "28c19d3c600e2595face7d838940a731f1a04932fe88a1d1c13d70a165b913ec");
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
    assert_eq!(signed.tx_hash, "0x194031f3ca2b5111d5e2e69530e6f744f9b9ccac59b1770d0a59b31a718e04a5");
    assert_eq!(v.get_proposal(id).unwrap().status, ProposalStatus::Signed);
}

#[test]
fn failed_mpc_call_marks_the_bill_failed() {
    let mut v = vault();
    let id = propose_evm(&mut v, evm_transfer());
    as_owner(DAY);
    let _ = v.approve(id);
    testing_env!(
        VMContextBuilder::new().current_account_id(acc(VAULT)).predecessor_account_id(acc(VAULT)).block_timestamp(DAY).build(),
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
    propose_evm(&mut v, EvmTransfer { chain_id: 1, ..evm_transfer() });
}

#[test]
#[should_panic(expected = "only the route's token can be sent")]
fn evm_bill_for_another_token_is_refused() {
    let mut v = vault();
    propose_evm(&mut v, EvmTransfer { token: "0x00000000000000000000000000000000000000bb".into(), ..evm_transfer() });
}

#[test]
#[should_panic(expected = "fee over the route's maximum")]
fn evm_bill_with_a_huge_fee_is_refused() {
    let mut v = vault();
    propose_evm(&mut v, EvmTransfer { max_fee_per_gas: U128(6_000_000_000), max_priority_fee_per_gas: U128(1), ..evm_transfer() });
}

#[test]
#[should_panic(expected = "gas limit over the route's maximum")]
fn evm_bill_with_too_much_gas_is_refused() {
    let mut v = vault();
    propose_evm(&mut v, EvmTransfer { gas_limit: 500_000, ..evm_transfer() });
}

#[test]
#[should_panic(expected = "receiver_id must be the payee's lowercase 0x address")]
fn evm_receiver_must_match_the_payee() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("northwind.testnet"), U128(5 * USDC), None, "x".into(), None, Some(evm_transfer()), None);
}

#[test]
#[should_panic(expected = "payee is on the blocklist")]
fn blocklisted_evm_address_is_refused() {
    let mut v = vault();
    as_owner(DAY);
    v.update_policy(PolicyUpdate { block: vec![acc(PAYEE_EVM)], ..Default::default() }, "scam wallet".into());
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

fn bill(r: &str) -> Option<String> {
    Some(r.to_string())
}

fn callback_result(ok: bool) {
    testing_env!(
        VMContextBuilder::new().current_account_id(acc(VAULT)).predecessor_account_id(acc(VAULT)).block_timestamp(DAY).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }],
    );
}

#[test]
#[should_panic(expected = "Keel Vault refused: this bill was already paid")]
fn agent_cannot_pay_the_same_bill_twice() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, bill("nw-nov"));
    assert!(v.bill_paid_at("nw-nov".into()).is_some());
    // The agent restarts, forgets, and tries again.
    as_agent(DAY + 60_000_000_000);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, bill("nw-nov"));
}

#[test]
fn different_bills_to_the_same_payee_are_both_paid() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, bill("nw-nov"));
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, bill("nw-dec"));
    assert_eq!(v.get_policy().spent_today, U128(160 * USDC));
}

#[test]
fn a_failed_transfer_frees_the_bill_to_be_paid_again() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, bill("nw-nov"));
    callback_result(false);
    v.on_payment_done(None, acc("northwind.testnet"), U128(80 * USDC), Some(1), bill("nw-nov"));
    assert_eq!(v.bill_paid_at("nw-nov".into()), None);
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, bill("nw-nov"));
}

#[test]
#[should_panic(expected = "Keel Vault refused: this bill was already paid")]
fn a_paid_bill_cannot_be_proposed() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, bill("nw-nov"));
    v.propose_payment(acc("northwind.testnet"), U128(80 * USDC), None, "again".into(), None, None, bill("nw-nov"));
}

#[test]
#[should_panic(expected = "Keel Vault refused: this bill was already paid")]
fn approving_a_bill_already_paid_is_refused() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("northwind.testnet"), U128(80 * USDC), None, "waiting".into(), None, None, bill("nw-nov"));
    // Later the agent pays the same bill directly, inside the caps.
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, bill("nw-nov"));
    as_owner(DAY);
    let _ = v.approve(1);
}

#[test]
fn a_newer_proposal_for_the_same_bill_replaces_the_old_one() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("deposit.1click.near"), U128(5 * USDC), None, "quote 1".into(), None, None, bill("base-oct"));
    v.propose_payment(acc("deposit2.1click.near"), U128(5 * USDC), None, "quote 2".into(), None, None, bill("base-oct"));
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
    v.propose_payment(acc("deposit.1click.near"), U128(5 * USDC), None, "quote 1".into(), None, None, bill("base-oct"));
    v.propose_payment(acc("deposit2.1click.near"), U128(5 * USDC), None, "quote 2".into(), None, None, bill("base-oct"));
    as_owner(DAY);
    let _ = v.approve(1);
}

#[test]
fn approving_marks_the_bill_paid_and_rejecting_does_not() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("atlas.testnet"), U128(50 * USDC), None, "a".into(), None, None, bill("atlas-1"));
    v.propose_payment(acc("atlas.testnet"), U128(50 * USDC), None, "b".into(), None, None, bill("atlas-2"));
    as_owner(DAY);
    let _ = v.approve(1);
    v.reject(2);
    assert!(v.bill_paid_at("atlas-1".into()).is_some());
    assert_eq!(v.bill_paid_at("atlas-2".into()), None);
    // A rejected bill can be proposed again.
    as_agent(DAY);
    assert_eq!(v.propose_payment(acc("atlas.testnet"), U128(50 * USDC), None, "c".into(), None, None, bill("atlas-2")), 3);
}

#[test]
fn a_failed_mpc_signature_frees_the_bill() {
    let mut v = vault();
    as_agent(DAY);
    let to = PAYEE_EVM.to_string();
    v.propose_payment(acc(&to), U128(5 * USDC), None, "base".into(), None, Some(evm_transfer()), bill("base-oct"));
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
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, bill("nw-nov"));
    as_owner(DAY);
    v.release_bill("nw-nov".into());
    assert_eq!(v.bill_paid_at("nw-nov".into()), None);
}

#[test]
#[should_panic(expected = "only the owner can call this")]
fn only_the_owner_can_release_a_bill() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, bill("nw-nov"));
    ctx(VAULT, AGENT_KEY, DAY, 1);
    v.release_bill("nw-nov".into());
}

#[test]
#[should_panic(expected = "bill_ref must be 1 to 64 characters")]
fn bill_ref_must_be_short() {
    let mut v = vault();
    as_agent(DAY);
    let _ = v.execute_payment(acc("northwind.testnet"), U128(80 * USDC), None, Some("x".repeat(65)));
}

// ------------------------------------------------- storage flood by a stolen agent key

#[test]
#[should_panic(expected = "50 proposals are already waiting")]
fn at_most_50_proposals_wait_at_once() {
    let mut v = vault();
    as_agent(DAY);
    for i in 0..51 {
        v.propose_payment(acc("atlas.testnet"), U128(USDC), None, "flood".into(), None, None, bill(&format!("flood-{i}")));
    }
}

#[test]
fn approving_or_rejecting_frees_a_waiting_slot() {
    let mut v = vault();
    as_agent(DAY);
    for i in 0..50 {
        v.propose_payment(acc("atlas.testnet"), U128(USDC), None, "x".into(), None, None, bill(&format!("b-{i}")));
    }
    as_owner(DAY);
    v.reject(1);
    let _ = v.approve(2);
    assert_eq!(v.pending_count(), 48);
    as_agent(DAY);
    v.propose_payment(acc("atlas.testnet"), U128(USDC), None, "x".into(), None, None, bill("b-50"));
    v.propose_payment(acc("atlas.testnet"), U128(USDC), None, "x".into(), None, None, bill("b-51"));
    assert_eq!(v.pending_count(), 50);
}

#[test]
fn reproposing_one_bill_forever_keeps_one_record() {
    let mut v = vault();
    as_agent(DAY);
    for _ in 0..200 {
        as_agent(DAY); // one transaction per proposal
        v.propose_payment(acc("atlas.testnet"), U128(USDC), None, "r".repeat(280), None, None, bill("same-bill"));
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
    v.propose_payment(acc("atlas.testnet"), U128(USDC), None, "x".into(), None, None, bill("low"));
}

#[test]
#[should_panic(expected = "the vault is low on NEAR for storage")]
fn agent_cannot_pay_into_the_storage_reserve() {
    let mut v = vault();
    low_on_near();
    let _ = v.execute_payment(acc("northwind.testnet"), U128(USDC), None, bill("low"));
}

#[test]
fn owner_can_still_act_when_the_vault_is_low_on_near() {
    let mut v = vault();
    as_agent(DAY);
    v.propose_payment(acc("atlas.testnet"), U128(USDC), None, "x".into(), None, None, bill("p"));
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
    let id = propose_evm(&mut v, EvmTransfer { chain_id: 421614, token: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d".into(), ..evm_transfer() });
    assert_eq!(v.get_proposal(id).unwrap().evm_amount, Some(U128(5 * USDC)));
}

#[test]
#[should_panic(expected = "only the route's token can be sent")]
fn base_usdc_cannot_be_sent_on_the_arbitrum_route() {
    let mut v = vault();
    propose_evm(&mut v, EvmTransfer { chain_id: 421614, ..evm_transfer() });
}

#[test]
fn an_18_decimal_token_gets_the_amount_scaled() {
    let mut v = vault();
    as_owner(DAY);
    // An owner-added chain whose stablecoin has 18 decimals.
    let token18 = "0x00000000000000000000000000000000000000c8";
    v.set_evm_route(100, Some(EvmRoute { chain_id: 100, token: token18.into(), decimals: 18, max_fee_per_gas: U128(5_000_000_000), max_gas: 100_000 }));
    let id = propose_evm(&mut v, EvmTransfer { chain_id: 100, token: token18.into(), ..evm_transfer() });
    // 5 USDC is 5 * 10^18 units of an 18-decimal token.
    assert_eq!(v.get_proposal(id).unwrap().evm_amount, Some(U128(5 * 10u128.pow(18))));
}

#[test]
#[should_panic(expected = "the route's token changed since the proposal")]
fn changing_a_routes_decimals_after_the_proposal_blocks_approval() {
    let mut v = vault();
    let id = propose_evm(&mut v, evm_transfer());
    as_owner(DAY);
    v.set_evm_route(84532, Some(EvmRoute { chain_id: 84532, token: BASE_USDC.into(), decimals: 18, max_fee_per_gas: U128(5_000_000_000), max_gas: 100_000 }));
    let _ = v.approve(id);
}

#[test]
#[should_panic(expected = "route.chain_id must match chain_id")]
fn route_chain_id_must_match() {
    let mut v = vault();
    as_owner(DAY);
    v.set_evm_route(1, Some(EvmRoute { chain_id: 56, token: BASE_USDC.into(), decimals: 6, max_fee_per_gas: U128(1), max_gas: 1 }));
}

#[test]
#[should_panic(expected = "token decimals must be 6 to 30")]
fn token_with_fewer_decimals_than_the_vault_is_refused() {
    let mut v = vault();
    as_owner(DAY);
    v.set_evm_route(1, Some(EvmRoute { chain_id: 1, token: BASE_USDC.into(), decimals: 2, max_fee_per_gas: U128(1), max_gas: 1 }));
}

#[test]
fn ethereum_sepolia_allows_a_higher_fee_than_base() {
    let mut v = vault();
    let eth_usdc = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
    // 40 gwei: over Base's 5 gwei cap, under Ethereum's 50.
    propose_evm(&mut v, EvmTransfer { chain_id: 11155111, token: eth_usdc.into(), max_fee_per_gas: U128(40_000_000_000), max_priority_fee_per_gas: U128(1_000_000_000), ..evm_transfer() });
}

#[test]
fn optimism_sepolia_bill_is_accepted() {
    let mut v = vault();
    let op_usdc = "0x5fd84259d66cd46123540766be93dfe6d43130d7";
    let id = propose_evm(&mut v, EvmTransfer { chain_id: 11155420, token: op_usdc.into(), ..evm_transfer() });
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
    v.add_bill(Bill { chain: Some("arb".into()), payee: "0x000000000000000000000000000000000000dead".into(), monthly: true, ..listed("lisbon", "x", 12) });
    let bills = v.get_bills();
    assert_eq!(bills.len(), 2);
    assert!(bills.iter().any(|b| b.id == "lisbon" && b.monthly && b.chain.as_deref() == Some("arb")));
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
        (listed("", "northwind.testnet", 1), "bill_ref must be 1 to 64 characters"),
        (listed("a:b", "northwind.testnet", 1), "bill id cannot contain ':'"),
        (listed("zero", "northwind.testnet", 0), "amount must be above zero"),
        (Bill { due: "2026-13-01".into(), ..listed("d", "northwind.testnet", 1) }, "due must be a date"),
        (Bill { due: "next week".into(), ..listed("d", "northwind.testnet", 1) }, "due must be a date"),
        (Bill { label: " ".into(), ..listed("l", "northwind.testnet", 1) }, "label is missing"),
        (Bill { label: "x".repeat(281), ..listed("l", "northwind.testnet", 1) }, "label is longer"),
        (listed("p", "Not A Near Account", 1), "payee must be a NEAR account id"),
        (Bill { chain: Some("solana".into()), ..listed("c", "0x000000000000000000000000000000000000dead", 1) }, "chain must be"),
        (Bill { chain: Some("base".into()), ..listed("c", "northwind.testnet", 1) }, "payee must be a lowercase 0x address"),
        (Bill { chain: Some("base".into()), ..listed("c", "0x000000000000000000000000000000000000DEAD", 1) }, "payee must be a lowercase 0x address"),
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
        assert!(msg.contains(want), "bill {id:?}: wanted {want:?}, got {msg:?}");
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
    assert_eq!(v.check_payment(acc("northwind.testnet"), U128(150 * USDC)).band, Band::NeedsApproval);
}
