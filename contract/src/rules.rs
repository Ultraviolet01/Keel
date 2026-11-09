//! The rules behind every agent `bill_ref`: periods, dates, chain names and the
//! bounds on NEAR Intents proposals.

use super::*;

/// How an agent's bill_ref is used, which decides what it must match.
#[derive(Clone, Copy)]
pub(crate) enum RefUse {
    /// A NEAR payment or proposal: payee and amount must be the bill's.
    Near,
    /// From the vault's EVM address on this chain id: 0x payee and amount must be the bill's.
    Evm(u64),
    /// A proposal paid on NEAR: for a NEAR bill, payee and amount must be the
    /// bill's; for a cross-chain bill it is a NEAR Intents deposit, and only
    /// the bill must exist.
    Proposal,
}

impl RefUse {
    pub(crate) fn from(evm: Option<&EvmTransfer>, proposal: bool) -> Self {
        match evm {
            Some(e) => RefUse::Evm(e.chain_id),
            None if proposal => RefUse::Proposal,
            None => RefUse::Near,
        }
    }
}

/// The chain ids a bill's chain name stands for (testnet and mainnet).
pub(crate) fn chain_ids(chain: &str) -> &'static [u64] {
    match chain {
        "base" => &[84532, 8453],
        "eth" => &[11155111, 1],
        "arb" => &[421614, 42161],
        "op" => &[11155420, 10],
        _ => &[],
    }
}

/// A one-off bill has no period; a monthly bill's is YYYY-MM and a yearly
/// bill's YYYY, from its first due date up to next month (or next year), so
/// a stolen key cannot pay far-future periods in advance.
pub(crate) fn check_period(bill: &Bill, period: Option<&str>) {
    let today = civil_date(env::block_timestamp() / NS_PER_DAY);
    let ok = match (bill.monthly, bill.yearly, period) {
        (false, false, None) => true,
        (true, _, Some(p)) => {
            let (y, m) = (
                today[..4].parse::<u32>().unwrap(),
                today[5..7].parse::<u32>().unwrap(),
            );
            let next = if m == 12 {
                format!("{}-01", y + 1)
            } else {
                format!("{y}-{:02}", m + 1)
            };
            p.len() == 7 && is_date(&format!("{p}-01")) && p >= &bill.due[..7] && p <= next.as_str()
        }
        (_, true, Some(p)) => {
            let y = today[..4].parse::<u32>().unwrap();
            p.len() == 4
                && p.bytes().all(|c| c.is_ascii_digit())
                && p >= &bill.due[..4]
                && p.parse::<u32>().map_or(false, |x| x <= y + 1)
        }
        _ => false,
    };
    require!(
        ok,
        "Keel Vault refused: the bill_ref's period does not fit the bill"
    );
}

/// A NEAR implicit account: 64 lowercase hex characters, the shape of every
/// 1Click deposit address on NEAR.
pub(crate) fn is_implicit(account: &str) -> bool {
    account.len() == 64
        && account
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The most a NEAR Intents proposal may send for a bill: 3% over it, the same
/// limit Keel's agent applies to quotes before it proposes one.
pub(crate) fn intents_max(bill: u128) -> u128 {
    bill.saturating_add(bill.saturating_mul(3).div_ceil(100))
}

/// Days since 1970-01-01 as YYYY-MM-DD (UTC).
pub(crate) fn civil_date(days: u64) -> String {
    // Howard Hinnant's days_from_civil, inverted.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

pub(crate) fn check_bill_ref(r: &str) {
    require!(
        !r.is_empty() && r.len() <= MAX_BILL_REF,
        "bill_ref must be 1 to 64 characters"
    );
}

/// YYYY-MM-DD with a real month and a day from 1 to 31.
pub(crate) fn is_date(d: &str) -> bool {
    let b = d.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| {
        d.get(r)
            .filter(|x| x.bytes().all(|c| c.is_ascii_digit()))
            .and_then(|x| x.parse::<u32>().ok())
    };
    matches!((num(0..4), num(5..7), num(8..10)), (Some(y), Some(m), Some(day)) if y >= 2000 && (1..=12).contains(&m) && (1..=31).contains(&day))
}

pub(crate) fn check_text(text: &str, field: &str) {
    if text.len() > MAX_TEXT {
        env::panic_str(&format!("{field} is longer than {MAX_TEXT} characters"));
    }
}
