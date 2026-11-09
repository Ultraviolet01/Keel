//! Network defaults: NEAR's Chain Signatures contract and the stablecoin routes a new vault starts with.

use super::*;

pub(crate) fn is_testnet() -> bool {
    env::current_account_id().as_str().ends_with(".testnet")
}

/// NEAR's Chain Signatures contract on this network.
pub(crate) fn default_mpc() -> AccountId {
    (if is_testnet() {
        "v1.signer-prod.testnet"
    } else {
        "v1.signer"
    })
    .parse()
    .unwrap()
}

/// The vault's own token (USDC) has 6 decimals; EVM amounts are scaled from it.
pub(crate) const VAULT_DECIMALS: u8 = 6;

/// Circle USDC on each chain (6 decimals). Gas is capped at 100k; the fee cap
/// bounds what a bad quote could burn: 5 gwei on the L2s (0.0005 ETH), 50 gwei
/// on Ethereum (0.005 ETH). The owner can add other chains, including tokens
/// with more decimals, with `set_evm_route`.
pub(crate) fn default_evm_routes() -> Vec<EvmRoute> {
    const GWEI: u128 = 1_000_000_000;
    let r = |chain_id: u64, token: &str, decimals: u8, gwei: u128| EvmRoute {
        chain_id,
        token: token.into(),
        decimals,
        max_fee_per_gas: U128(gwei * GWEI),
        max_gas: 100_000,
        auto_cap: None,
    };
    if is_testnet() {
        vec![
            r(84532, "0x036cbd53842c5426634e7929541ec2318f3dcf7e", 6, 5),
            r(
                11155111,
                "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
                6,
                50,
            ),
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
