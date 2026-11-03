//! Builds the one kind of EVM transaction a Keel Vault will ever ask NEAR's
//! Chain Signatures network to sign: an EIP-1559 ERC-20 `transfer` of the
//! route's stablecoin. The vault builds and hashes the transaction itself, so
//! the agent can never get an arbitrary payload signed.

use near_sdk::env;
use near_sdk::json_types::U128;
use near_sdk::near;

/// ERC-20 `transfer(address,uint256)` selector.
const TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];

/// The chain and token the owner allows, and the most the agent may offer in fees.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmRoute {
    pub chain_id: u64,
    /// The stablecoin contract, 0x-prefixed.
    pub token: String,
    /// The token's decimals on that chain (USDC: 6; some stablecoins use 18).
    pub decimals: u8,
    pub max_fee_per_gas: U128,
    pub max_gas: u64,
}

/// The fields the agent fills in from the chain when it proposes.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmTransfer {
    pub chain_id: u64,
    pub token: String,
    /// The payee's 0x address.
    pub to: String,
    pub nonce: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub gas_limit: u64,
}

/// What the vault stores once the MPC network signs.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmSigned {
    /// The signed transaction, ready for eth_sendRawTransaction.
    pub raw_tx: String,
    pub tx_hash: String,
}

pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let b = hex_decode(s.strip_prefix("0x")?)?;
    b.try_into().ok()
}

/// Lowercase 0x address, which is also a valid NEAR account ID, so the vault's
/// blocklist and proposal view work for EVM payees too.
pub fn normalize_address(s: &str) -> Option<String> {
    parse_address(s).map(|a| format!("0x{}", hex_encode(&a)))
}

impl EvmTransfer {
    fn fields(&self, amount: u128) -> Vec<Vec<u8>> {
        let token = parse_address(&self.token).expect("bad token address");
        let to = parse_address(&self.to).expect("bad payee address");
        let mut data = TRANSFER.to_vec();
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(&to);
        data.extend_from_slice(&[0u8; 16]);
        data.extend_from_slice(&amount.to_be_bytes());
        vec![
            rlp_uint(self.chain_id as u128),
            rlp_uint(self.nonce as u128),
            rlp_uint(self.max_priority_fee_per_gas.0),
            rlp_uint(self.max_fee_per_gas.0),
            rlp_uint(self.gas_limit as u128),
            rlp_bytes(&token),
            rlp_uint(0),
            rlp_bytes(&data),
            vec![0xc0], // empty access list
        ]
    }

    /// keccak256 of the unsigned typed transaction: what the MPC network signs.
    pub fn signing_hash(&self, amount: u128) -> [u8; 32] {
        env::keccak256_array(&typed(rlp_list(&self.fields(amount))))
    }

    pub fn signed(&self, amount: u128, y_parity: u8, r: &[u8], s: &[u8]) -> EvmSigned {
        let mut f = self.fields(amount);
        f.push(rlp_uint(y_parity as u128));
        f.push(rlp_bytes(strip_zeros(r)));
        f.push(rlp_bytes(strip_zeros(s)));
        let raw = typed(rlp_list(&f));
        EvmSigned {
            tx_hash: format!("0x{}", hex_encode(&env::keccak256_array(&raw))),
            raw_tx: format!("0x{}", hex_encode(&raw)),
        }
    }
}

fn typed(rlp: Vec<u8>) -> Vec<u8> {
    let mut out = vec![0x02];
    out.extend(rlp);
    out
}

fn strip_zeros(b: &[u8]) -> &[u8] {
    let i = b.iter().position(|&x| x != 0).unwrap_or(b.len());
    &b[i..]
}

fn rlp_uint(n: u128) -> Vec<u8> {
    rlp_bytes(strip_zeros(&n.to_be_bytes()))
}

fn rlp_len(len: usize, short: u8, long: u8) -> Vec<u8> {
    if len <= 55 {
        vec![short + len as u8]
    } else {
        let be = (len as u64).to_be_bytes();
        let be = strip_zeros(&be);
        let mut out = vec![long + be.len() as u8];
        out.extend_from_slice(be);
        out
    }
}

fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = rlp_len(b.len(), 0x80, 0xb7);
    out.extend_from_slice(b);
    out
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.concat();
    let mut out = rlp_len(payload.len(), 0xc0, 0xf7);
    out.extend(payload);
    out
}

pub fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}
