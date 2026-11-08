//! Stored records (Borsh, fixed and bounded sizes) and their JSON views.

use crate::board::{hex, Board, Verdict, TEMPLATE_NAMES};
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Profile {
    pub crowbars: u8,
    pub crafted: u32,
    pub consumed: u32,
    pub rounds_played: u32,
    pub valid_reveals: u32,
    pub wins: u32,
    pub bag_won: u128,
    pub registered_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ProfileView {
    pub account_id: AccountId,
    pub crowbars: u8,
    pub crafted: u32,
    pub consumed: u32,
    pub rounds_played: u32,
    pub valid_reveals: u32,
    pub wins: u32,
    pub bag_won: U128,
    pub registered_at: U64,
}

impl Profile {
    pub fn view(&self, account_id: AccountId) -> ProfileView {
        ProfileView {
            account_id,
            crowbars: self.crowbars,
            crafted: self.crafted,
            consumed: self.consumed,
            rounds_played: self.rounds_played,
            valid_reveals: self.valid_reveals,
            wins: self.wins,
            bag_won: U128(self.bag_won),
            registered_at: U64(self.registered_at),
        }
    }
}

/// The ranking key of a valid reveal: more loot, then fewer moves, then the
/// earlier commitment sequence.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Score {
    pub player_id: AccountId,
    pub loot: u16,
    pub length: u16,
    pub sequence: u32,
}

impl Score {
    pub fn beats(&self, other: &Score) -> bool {
        (self.loot, std::cmp::Reverse(self.length), std::cmp::Reverse(self.sequence))
            > (other.loot, std::cmp::Reverse(other.length), std::cmp::Reverse(other.sequence))
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Round {
    pub id: u64,
    pub template: u8,
    pub transform: u8,
    pub board: Board,
    pub board_hash: [u8; 32],
    pub opened_by: AccountId,
    pub opened_at: u64,
    pub commitment_end: u64,
    pub reveal_end: u64,
    pub participants: u32,
    pub valid_reveals: u32,
    pub invalid_reveals: u32,
    pub best: Option<Score>,
    pub finalized_at: Option<u64>,
    pub winner: Option<AccountId>,
    pub claimed: bool,
    pub burned: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Commit,
    Reveal,
    AwaitingFinalization,
    Finalized,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RoundView {
    pub id: U64,
    pub template: u8,
    pub template_name: String,
    pub transform: u8,
    pub board: Board,
    pub board_hash: String,
    pub opened_by: AccountId,
    pub opened_at: U64,
    pub commitment_end: U64,
    pub reveal_end: U64,
    pub participants: u32,
    pub valid_reveals: u32,
    pub invalid_reveals: u32,
    pub best: Option<Score>,
    pub finalized: bool,
    pub finalized_at: Option<U64>,
    pub winner: Option<AccountId>,
    pub prize: U128,
    pub claimed: bool,
    pub burned: bool,
    /// Phase at the block timestamp of the view call.
    pub phase: Phase,
}

impl Round {
    pub fn phase(&self, now: u64) -> Phase {
        if self.finalized_at.is_some() {
            Phase::Finalized
        } else if now < self.commitment_end {
            Phase::Commit
        } else if now < self.reveal_end {
            Phase::Reveal
        } else {
            Phase::AwaitingFinalization
        }
    }

    pub fn view(&self, now: u64, prize: u128) -> RoundView {
        RoundView {
            id: U64(self.id),
            template: self.template,
            template_name: TEMPLATE_NAMES[usize::from(self.template)].to_string(),
            transform: self.transform,
            board: self.board.clone(),
            board_hash: hex(&self.board_hash),
            opened_by: self.opened_by.clone(),
            opened_at: U64(self.opened_at),
            commitment_end: U64(self.commitment_end),
            reveal_end: U64(self.reveal_end),
            participants: self.participants,
            valid_reveals: self.valid_reveals,
            invalid_reveals: self.invalid_reveals,
            best: self.best.clone(),
            finalized: self.finalized_at.is_some(),
            finalized_at: self.finalized_at.map(U64),
            winner: self.winner.clone(),
            prize: U128(prize),
            claimed: self.claimed,
            burned: self.burned,
            phase: self.phase(now),
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Reveal {
    pub verdict: Verdict,
    pub loot: u16,
    pub length: u16,
    pub doors: u8,
    pub moves: String,
    pub revealed_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RevealView {
    pub valid: bool,
    pub verdict: Verdict,
    pub loot: u16,
    pub length: u16,
    pub doors: u8,
    pub moves: String,
    pub revealed_at: U64,
}

impl Reveal {
    pub fn view(&self) -> RevealView {
        RevealView {
            valid: self.verdict == Verdict::Ok,
            verdict: self.verdict,
            loot: self.loot,
            length: self.length,
            doors: self.doors,
            moves: self.moves.clone(),
            revealed_at: U64(self.revealed_at),
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Commitment {
    pub hash: [u8; 32],
    pub use_crowbar: bool,
    /// Serial number of the crowbar consumed by this commitment.
    pub crowbar_serial: Option<u32>,
    pub sequence: u32,
    pub committed_at: u64,
    pub reveal: Option<Reveal>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CommitmentView {
    pub round_id: U64,
    pub player_id: AccountId,
    pub commitment_hash: String,
    pub use_crowbar: bool,
    pub crowbar_serial: Option<u32>,
    pub sequence: u32,
    pub committed_at: U64,
    pub reveal: Option<RevealView>,
}

impl Commitment {
    pub fn view(&self, round_id: u64, player_id: AccountId) -> CommitmentView {
        CommitmentView {
            round_id: U64(round_id),
            player_id,
            commitment_hash: hex(&self.hash),
            use_crowbar: self.use_crowbar,
            crowbar_serial: self.crowbar_serial,
            sequence: self.sequence,
            committed_at: U64(self.committed_at),
            reveal: self.reveal.as_ref().map(Reveal::view),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CrowbarStatus {
    Ready,
    Consumed,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CrowbarView {
    pub owner_id: AccountId,
    pub serial: u32,
    pub status: CrowbarStatus,
    pub consumed_in_round: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub network: String,
    pub contract_id: AccountId,
    pub token_name: String,
    pub token_symbol: String,
    pub decimals: u8,
    pub initial_supply: U128,
    pub round_prize: U128,
    pub crowbar_price: U128,
    pub commitment_window_ns: U64,
    pub reveal_window_ns: U64,
    pub board_size: u8,
    pub max_route_length: u8,
    pub max_participants: u32,
    pub max_crowbars: u8,
    pub template_count: u8,
    pub profile_deposit: U128,
    pub round_deposit: U128,
    pub commitment_deposit: U128,
    pub storage_deposits_retained: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StateView {
    pub round_count: U64,
    pub current_round_id: Option<U64>,
    pub current_phase: Option<Phase>,
    pub profile_count: U64,
    pub total_supply: U128,
    pub treasury_balance: U128,
    pub unallocated_game_budget: U128,
    pub reserved_prizes: U128,
    pub cumulative_rewards_paid: U128,
    pub cumulative_expired_pots_burned: U128,
    pub cumulative_crafting_burned: U128,
    pub cumulative_storage_burned: U128,
    pub cumulative_resolver_burned: U128,
    /// unallocated + reserved + rewards paid + expired pots == initial supply.
    pub budget_identity_holds: bool,
    /// treasury balance >= unallocated + reserved.
    pub treasury_covers_budget: bool,
    /// total supply + every recorded burn == initial supply.
    pub supply_audit_holds: bool,
    pub block_timestamp: U64,
    pub block_height: U64,
}
