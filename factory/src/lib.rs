//! Keel factory
//!
//! When a founder signs up in the Keel app, or adds another company, the app
//! calls `create_vault` from the founder's own wallet. One founder can own up
//! to 20 vaults, one per company. In one transaction the factory creates
//! `<name>.<factory>` with the Keel Vault code, sets the founder as owner, and
//! adds Keel's agent key to the vault account as a function-call key that can
//! only call that vault's `execute_payment`, `propose_payment` and `recall_from_yield`
//! (which only brings savings back into the vault). So the agent
//! is connected the moment the vault exists, with no backend step. A callback
//! then registers the vault on the token so it can receive USDC. The vault
//! starts with no policy: the founder sets every limit.
//!
//! The admin uploads the vault code once with `set_vault_code`. Every vault
//! gets an exact copy, and `get_config` shows the code's SHA-256 hash so
//! anyone can check it against the wasm built from this repository.
//!
//! Each vault stores its own copy of the code, so the founder's deposit pays
//! about 2 NEAR of storage. On mainnet with many founders, NEAR global
//! contracts (code stored once, referenced by hash) would make vaults cheaper,
//! at the cost of burning about 20 NEAR once to publish the code.

use near_sdk::json_types::Base58CryptoHash;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableSet, LazyOption, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Allowance, BorshStorageKey, CryptoHash, Gas,
    NearToken, PanicOnDefault, Promise, PromiseResult, PublicKey,
};

/// Room for the vault's own state on top of its code (proposals, lists) and
/// for the gas its agent key spends.
const VAULT_STATE_ALLOWANCE: NearToken = NearToken::from_millinear(500);
/// The agent key's permissions on each vault.
const AGENT_METHODS: &str = "execute_payment,propose_payment,recall_from_yield";
const AGENT_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(250);
/// NEP-145 registration of the new vault on the token (0.00125 NEAR).
const TOKEN_REGISTRATION: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const GAS_VAULT_INIT: Gas = Gas::from_tgas(20);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(30);
/// One vault per company; this caps how many companies one founder can add.
const MAX_VAULTS_PER_OWNER: usize = 20;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    /// Old one-vault-per-founder map, kept only so `migrate` can read it.
    VaultByOwner,
    Vaults,
    VaultCode,
    VaultsByOwner,
    VaultOwner,
}

#[near(serializers = [json])]
pub struct FactoryConfig {
    pub admin_id: AccountId,
    pub agent_key: PublicKey,
    pub token_id: AccountId,
    pub vault_code_hash: Option<Base58CryptoHash>,
    pub vault_code_bytes: u64,
    pub min_vault_deposit: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct KeelFactory {
    admin_id: AccountId,
    agent_key: PublicKey,
    token_id: AccountId,
    vault_code: LazyOption<Vec<u8>>,
    vault_code_hash: Option<CryptoHash>,
    vault_code_bytes: u64,
    vaults_by_owner: LookupMap<AccountId, Vec<AccountId>>,
    vault_owner: LookupMap<AccountId, AccountId>,
    vaults: IterableSet<AccountId>,
}

/// State layout when the agent was a separate account instead of a key.
#[near(serializers = [borsh])]
struct KeelFactoryV2 {
    admin_id: AccountId,
    agent_id: AccountId,
    token_id: AccountId,
    vault_code: LazyOption<Vec<u8>>,
    vault_code_hash: Option<CryptoHash>,
    vault_code_bytes: u64,
    vaults_by_owner: LookupMap<AccountId, Vec<AccountId>>,
    vault_owner: LookupMap<AccountId, AccountId>,
    vaults: IterableSet<AccountId>,
}

#[near]
impl KeelFactory {
    #[init]
    pub fn new(admin_id: AccountId, agent_key: PublicKey, token_id: AccountId) -> Self {
        Self {
            admin_id,
            agent_key,
            token_id,
            vault_code: LazyOption::new(StorageKey::VaultCode, None),
            vault_code_hash: None,
            vault_code_bytes: 0,
            vaults_by_owner: LookupMap::new(StorageKey::VaultsByOwner),
            vault_owner: LookupMap::new(StorageKey::VaultOwner),
            vaults: IterableSet::new(StorageKey::Vaults),
        }
    }

    /// Upgrades a factory from the version where the agent was a separate
    /// account. Vaults created before this keep their old agent setup; new
    /// vaults get `agent_key` on the vault account.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(agent_key: PublicKey) -> Self {
        let old: KeelFactoryV2 =
            env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"));
        Self {
            admin_id: old.admin_id,
            agent_key,
            token_id: old.token_id,
            vault_code: old.vault_code,
            vault_code_hash: old.vault_code_hash,
            vault_code_bytes: old.vault_code_bytes,
            vaults_by_owner: old.vaults_by_owner,
            vault_owner: old.vault_owner,
            vaults: old.vaults,
        }
    }

    /// Called by the founder's wallet at sign-up and for each company they
    /// add. Creates `<name>.<factory>` owned by the caller.
    #[payable]
    pub fn create_vault(&mut self, name: String) -> Promise {
        let owner_id = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(self.vault_code_hash.is_some(), "vault code has not been uploaded yet");
        let min_deposit = self.min_vault_deposit();
        let owned = self.vaults_by_owner.get(&owner_id).map_or(0, Vec::len);
        require!(
            owned < MAX_VAULTS_PER_OWNER,
            format!("one founder can own at most {MAX_VAULTS_PER_OWNER} vaults")
        );
        require!(
            deposit >= min_deposit,
            format!("attach at least {} to create a vault", min_deposit.exact_amount_display())
        );
        validate_name(&name);
        let vault_id: AccountId = format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("that name cannot be used for a vault"));
        require!(!self.vaults.contains(&vault_id), "that vault name is taken");

        // Reserve now so two sign-ups cannot race for the same name.
        self.vaults_by_owner
            .entry(owner_id.clone())
            .or_default()
            .push(vault_id.clone());
        self.vault_owner.insert(vault_id.clone(), owner_id.clone());
        self.vaults.insert(vault_id.clone());

        let init_args = json!({
            "owner_id": owner_id,
            "agent_key": self.agent_key,
            "token_id": self.token_id,
        })
        .to_string()
        .into_bytes();

        Promise::new(vault_id.clone())
            .create_account()
            .transfer(deposit.saturating_sub(TOKEN_REGISTRATION))
            .deploy_contract(self.vault_code.get().clone().unwrap())
            .add_access_key_allowance(
                self.agent_key.clone(),
                Allowance::limited(AGENT_KEY_ALLOWANCE).unwrap(),
                vault_id.clone(),
                AGENT_METHODS,
            )
            .function_call("new".to_string(), init_args, NearToken::from_yoctonear(0), GAS_VAULT_INIT)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_vault_created(owner_id, vault_id, deposit),
            )
    }

    #[private]
    pub fn on_vault_created(
        &mut self,
        owner_id: AccountId,
        vault_id: AccountId,
        deposit: NearToken,
    ) -> Option<AccountId> {
        #[allow(deprecated)]
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if ok {
            // Register the vault on the token so it can receive USDC.
            ext_ft::ext(self.token_id.clone())
                .with_attached_deposit(TOKEN_REGISTRATION)
                .with_static_gas(GAS_STORAGE_DEPOSIT)
                .storage_deposit(Some(vault_id.clone()), Some(true))
                .detach();
            emit(
                "vault_created",
                json!({ "owner_id": owner_id, "vault_id": vault_id, "agent_key": self.agent_key }),
            );
            Some(vault_id)
        } else {
            // Creation failed: free the name and give the founder their NEAR back.
            if let Some(list) = self.vaults_by_owner.get_mut(&owner_id) {
                list.retain(|v| v != &vault_id);
            }
            self.vault_owner.remove(&vault_id);
            self.vaults.remove(&vault_id);
            Promise::new(owner_id.clone()).transfer(deposit).detach();
            emit(
                "vault_creation_failed",
                json!({ "owner_id": owner_id, "vault_id": vault_id, "refunded": deposit }),
            );
            None
        }
    }

    /// Admin only: uploads the vault wasm, sent as the raw call input, used
    /// for vaults created from now on. Existing vaults keep their code.
    pub fn set_vault_code(&mut self) {
        require!(
            env::predecessor_account_id() == self.admin_id,
            "only the admin can call this"
        );
        let code = env::input().unwrap_or_else(|| env::panic_str("send the wasm as the call input"));
        require!(code.starts_with(b"\0asm"), "input is not a wasm file");
        let hash: CryptoHash = env::sha256_array(&code);
        self.vault_code_bytes = code.len() as u64;
        self.vault_code_hash = Some(hash);
        self.vault_code.set(Some(code));
        emit(
            "vault_code_changed",
            json!({ "vault_code_hash": Base58CryptoHash::from(hash), "bytes": self.vault_code_bytes }),
        );
    }

    /// Admin only: the agent key added to vaults created from now on.
    /// Existing vaults keep theirs; their owners can change it themselves.
    pub fn set_agent_key(&mut self, agent_key: PublicKey) {
        require!(
            env::predecessor_account_id() == self.admin_id,
            "only the admin can call this"
        );
        emit("agent_key_changed", json!({ "agent_key": agent_key }));
        self.agent_key = agent_key;
    }

    /// Admin only: the stablecoin vaults created from now on hold and pay, for
    /// example Circle's USDC. Existing vaults keep the token they were made with.
    pub fn set_token(&mut self, token_id: AccountId) {
        require!(
            env::predecessor_account_id() == self.admin_id,
            "only the admin can call this"
        );
        emit("token_changed", json!({ "old": self.token_id, "new": token_id }));
        self.token_id = token_id;
    }

    // ----------------------------------------------------------------- views

    /// Every vault a founder owns, in the order they were created. The app
    /// uses this for its company switcher.
    pub fn get_vaults_for_owner(&self, owner_id: AccountId) -> Vec<AccountId> {
        self.vaults_by_owner.get(&owner_id).cloned().unwrap_or_default()
    }

    pub fn get_owner(&self, vault_id: AccountId) -> Option<AccountId> {
        self.vault_owner.get(&vault_id).cloned()
    }

    pub fn get_vaults(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<AccountId> {
        self.vaults
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }

    pub fn get_config(&self) -> FactoryConfig {
        FactoryConfig {
            admin_id: self.admin_id.clone(),
            agent_key: self.agent_key.clone(),
            token_id: self.token_id.clone(),
            vault_code_hash: self.vault_code_hash.map(Base58CryptoHash::from),
            vault_code_bytes: self.vault_code_bytes,
            min_vault_deposit: self.min_vault_deposit(),
        }
    }
}

impl KeelFactory {
    /// Storage for the vault's copy of the code, room for its state, and the
    /// token registration.
    fn min_vault_deposit(&self) -> NearToken {
        env::storage_byte_cost()
            .saturating_mul(self.vault_code_bytes as u128)
            .saturating_add(VAULT_STATE_ALLOWANCE)
            .saturating_add(TOKEN_REGISTRATION)
    }
}

/// 2 to 32 characters: lowercase letters, digits, `-` and `_`, starting and
/// ending with a letter or digit.
fn validate_name(name: &str) {
    let ok_chars = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    let ok_ends = name
        .chars()
        .next()
        .zip(name.chars().last())
        .is_some_and(|(a, b)| a.is_ascii_alphanumeric() && b.is_ascii_alphanumeric());
    if !(2..=32).contains(&name.len()) || !ok_chars || !ok_ends {
        env::panic_str(
            "vault name must be 2 to 32 lowercase letters, digits, - or _, starting and ending with a letter or digit",
        );
    }
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "keel", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, RuntimeFeesConfig};

    fn acc(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn agent_key() -> PublicKey {
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
    }

    fn ctx(predecessor: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("keel.testnet"))
            .predecessor_account_id(acc(predecessor))
            .attached_deposit(deposit)
            .build());
    }

    fn factory() -> KeelFactory {
        ctx("admin.testnet", NearToken::from_yoctonear(0));
        let mut f = KeelFactory::new(
            acc("admin.testnet"),
            agent_key(),
            acc("usdc.testnet"),
        );
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("keel.testnet"))
            .predecessor_account_id(acc("admin.testnet"))
            .build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![], );
        upload(&mut f, b"\0asm fake vault code");
        f
    }

    fn upload(f: &mut KeelFactory, code: &[u8]) {
        let mut context = VMContextBuilder::new()
            .current_account_id(acc("keel.testnet"))
            .predecessor_account_id(acc("admin.testnet"))
            .build();
        context.input = std::rc::Rc::from(code.to_vec());
        testing_env!(context);
        f.set_vault_code();
    }

    fn min(f: &KeelFactory) -> NearToken {
        f.get_config().min_vault_deposit
    }

    fn callback_ctx(result: PromiseResult) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acc("keel.testnet"))
                .predecessor_account_id(acc("keel.testnet"))
                .build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![result],
        );
    }

    #[test]
    fn founder_creates_vault_named_after_company() {
        let mut f = factory();
        let m = min(&f);
        ctx("founder.testnet", m);
        let _ = f.create_vault("kora".into());
        assert_eq!(f.get_vaults_for_owner(acc("founder.testnet")), vec![acc("kora.keel.testnet")]);
        assert_eq!(f.get_vaults(None, None), vec![acc("kora.keel.testnet")]);
    }

    #[test]
    fn migrate_switches_to_agent_key_and_keeps_vaults() {
        ctx("keel.testnet", NearToken::from_yoctonear(0));
        let mut v2 = KeelFactoryV2 {
            admin_id: acc("keel.testnet"),
            agent_id: acc("agent.keel.testnet"),
            token_id: acc("usdc.testnet"),
            vault_code: LazyOption::new(StorageKey::VaultCode, Some(b"\0asm x".to_vec())),
            vault_code_hash: Some([1u8; 32]),
            vault_code_bytes: 6,
            vaults_by_owner: LookupMap::new(StorageKey::VaultsByOwner),
            vault_owner: LookupMap::new(StorageKey::VaultOwner),
            vaults: IterableSet::new(StorageKey::Vaults),
        };
        v2.vaults_by_owner.insert(acc("founder.testnet"), vec![acc("kora.keel.testnet")]);
        v2.vault_owner.insert(acc("kora.keel.testnet"), acc("founder.testnet"));
        v2.vaults.insert(acc("kora.keel.testnet"));
        v2.vaults_by_owner.flush();
        v2.vault_owner.flush();
        v2.vaults.flush();
        v2.vault_code.flush();
        env::state_write(&v2);

        let f = KeelFactory::migrate(agent_key());
        assert_eq!(f.get_config().agent_key, agent_key());
        assert_eq!(f.get_vaults_for_owner(acc("founder.testnet")), vec![acc("kora.keel.testnet")]);
        assert_eq!(f.get_owner(acc("kora.keel.testnet")), Some(acc("founder.testnet")));
        assert_eq!(f.get_config().vault_code_bytes, 6);
    }

    #[test]
    fn founder_can_own_several_companies() {
        let mut f = factory();
        let m = min(&f);
        ctx("founder.testnet", m);
        let _ = f.create_vault("kora".into());
        ctx("founder.testnet", m);
        let _ = f.create_vault("lumen".into());
        assert_eq!(
            f.get_vaults_for_owner(acc("founder.testnet")),
            vec![acc("kora.keel.testnet"), acc("lumen.keel.testnet")]
        );
        assert_eq!(f.get_owner(acc("lumen.keel.testnet")), Some(acc("founder.testnet")));
    }

    #[test]
    #[should_panic(expected = "one founder can own at most 20 vaults")]
    fn caps_vaults_per_founder() {
        let mut f = factory();
        let m = min(&f);
        for i in 0..=MAX_VAULTS_PER_OWNER {
            ctx("founder.testnet", m);
            let _ = f.create_vault(format!("co{i}"));
        }
    }

    #[test]
    fn failed_creation_keeps_founders_other_vaults() {
        let mut f = factory();
        let m = min(&f);
        ctx("founder.testnet", m);
        let _ = f.create_vault("kora".into());
        ctx("founder.testnet", m);
        let _ = f.create_vault("lumen".into());
        callback_ctx(PromiseResult::Failed);
        f.on_vault_created(acc("founder.testnet"), acc("lumen.keel.testnet"), m);
        assert_eq!(f.get_vaults_for_owner(acc("founder.testnet")), vec![acc("kora.keel.testnet")]);
        assert_eq!(f.get_owner(acc("lumen.keel.testnet")), None);
    }

    #[test]
    #[should_panic(expected = "that vault name is taken")]
    fn names_are_unique() {
        let mut f = factory();
        let m = min(&f);
        ctx("founder.testnet", m);
        let _ = f.create_vault("kora".into());
        ctx("other.testnet", m);
        let _ = f.create_vault("kora".into());
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn needs_minimum_deposit() {
        let mut f = factory();
        ctx("founder.testnet", NearToken::from_millinear(100));
        let _ = f.create_vault("kora".into());
    }

    #[test]
    #[should_panic(expected = "vault name must be")]
    fn rejects_bad_names() {
        let mut f = factory();
        let m = min(&f);
        ctx("founder.testnet", m);
        let _ = f.create_vault("Kora.Supply".into());
    }

    #[test]
    fn admin_switches_new_vaults_to_another_token() {
        let mut f = factory();
        ctx("admin.testnet", NearToken::from_yoctonear(0));
        f.set_token(acc("3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"));
        assert_eq!(f.get_config().token_id, acc("3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"));
        assert!(get_logs().iter().any(|l| l.contains("token_changed")));
    }

    #[test]
    #[should_panic(expected = "only the admin can call this")]
    fn only_admin_changes_the_token() {
        let mut f = factory();
        ctx("founder.testnet", NearToken::from_yoctonear(0));
        f.set_token(acc("attacker-token.testnet"));
    }

    #[test]
    #[should_panic(expected = "only the admin can call this")]
    fn only_admin_changes_agent_key() {
        let mut f = factory();
        ctx("founder.testnet", NearToken::from_yoctonear(0));
        f.set_agent_key("ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847".parse().unwrap());
    }

    #[test]
    fn success_callback_returns_vault_and_logs() {
        let mut f = factory();
        let m = min(&f);
        ctx("founder.testnet", m);
        let _ = f.create_vault("kora".into());
        callback_ctx(PromiseResult::Successful(vec![]));
        let vault = f.on_vault_created(acc("founder.testnet"), acc("kora.keel.testnet"), m);
        assert_eq!(vault, Some(acc("kora.keel.testnet")));
        assert!(get_logs().iter().any(|l| l.contains("vault_created")));
    }

    #[test]
    fn failed_creation_frees_name_and_refunds() {
        let mut f = factory();
        let m = min(&f);
        ctx("founder.testnet", m);
        let _ = f.create_vault("kora".into());
        callback_ctx(PromiseResult::Failed);
        let vault = f.on_vault_created(acc("founder.testnet"), acc("kora.keel.testnet"), m);
        assert_eq!(vault, None);
        assert!(f.get_vaults_for_owner(acc("founder.testnet")).is_empty());
        assert!(f.get_vaults(None, None).is_empty());
        assert!(get_logs().iter().any(|l| l.contains("vault_creation_failed")));
    }

    #[test]
    #[should_panic(expected = "only the admin can call this")]
    fn only_admin_uploads_vault_code() {
        let mut f = factory();
        let mut context = VMContextBuilder::new()
            .current_account_id(acc("keel.testnet"))
            .predecessor_account_id(acc("founder.testnet"))
            .build();
        context.input = std::rc::Rc::from(b"\0asm evil".to_vec());
        testing_env!(context);
        f.set_vault_code();
    }

    #[test]
    #[should_panic(expected = "input is not a wasm file")]
    fn rejects_non_wasm_code() {
        let mut f = factory();
        upload(&mut f, b"not wasm");
    }

    #[test]
    fn config_shows_code_hash_and_deposit() {
        let f = factory();
        let config = f.get_config();
        let expected: Base58CryptoHash = env::sha256_array(b"\0asm fake vault code").into();
        assert_eq!(config.vault_code_hash, Some(expected));
        assert!(config.min_vault_deposit > VAULT_STATE_ALLOWANCE);
    }

    #[test]
    #[should_panic(expected = "vault code has not been uploaded yet")]
    fn cannot_create_before_code_upload() {
        ctx("admin.testnet", NearToken::from_yoctonear(0));
        let mut f = KeelFactory::new(acc("admin.testnet"), agent_key(), acc("usdc.testnet"));
        ctx("founder.testnet", NearToken::from_near(3));
        let _ = f.create_vault("kora".into());
    }
}
