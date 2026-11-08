//! BAG HEIST: a commit-reveal route puzzle whose rounds pay out of, or burn
//! from, a fixed BAG treasury. One contract holds the NEP-141 token and the
//! game, so every prize settles as an internal balance move in the same
//! receipt that marks it claimed.

pub mod board;
pub mod types;

#[cfg(test)]
mod tests;

use board::*;
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault,
    PromiseOrValue,
};
use types::*;

pub const TOKEN_NAME: &str = "Bag Heist";
pub const TOKEN_SYMBOL: &str = "BAG";
pub const DECIMALS: u8 = 6;
/// 1,000,000 BAG with 6 decimals.
pub const INITIAL_SUPPLY: u128 = 1_000_000_000_000;
/// 100 BAG.
pub const ROUND_PRIZE: u128 = 100_000_000;
/// 5 BAG.
pub const CROWBAR_PRICE: u128 = 5_000_000;
pub const COMMITMENT_WINDOW_NS: u64 = 120_000_000_000;
pub const REVEAL_WINDOW_NS: u64 = 120_000_000_000;
pub const MAX_PARTICIPANTS: u32 = 64;
pub const MAX_CROWBARS: u8 = 10;

/// Retained storage deposits. Each is several times the measured worst-case
/// growth (64-character account IDs) reported by `storage_deposits_cover_worst_case`.
pub const PROFILE_DEPOSIT: u128 = 5_000_000_000_000_000_000_000; // 0.005 NEAR
pub const ROUND_DEPOSIT: u128 = 20_000_000_000_000_000_000_000; // 0.02 NEAR
pub const COMMITMENT_DEPOSIT: u128 = 20_000_000_000_000_000_000_000; // 0.02 NEAR

/// Bytes a round can still grow after opening (best score, winner, finalization time).
pub const ROUND_GROWTH_RESERVE: u64 = 160;
/// Bytes the largest permitted reveal adds to a commitment.
pub const REVEAL_GROWTH_RESERVE: u64 = 56;

const BAG_ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b1418'/%3E%3Cpath d='M22 24h20l7 26a4 4 0 0 1-4 5H19a4 4 0 0 1-4-5z' fill='%23ffb547'/%3E%3Cpath d='M24 11l8 5 8-5-3 11H27z' fill='%23ffb547'/%3E%3Cpath d='M32 30v18m5-14h-7a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-7' stroke='%230b1418' stroke-width='3' fill='none' stroke-linecap='round'/%3E%3C/svg%3E";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    FungibleToken,
    Profiles,
    Rounds,
    Participants,
    Commitments,
    CrowbarUses,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct BagHeist {
    token: FungibleToken,
    profiles: LookupMap<AccountId, Profile>,
    rounds: LookupMap<u64, Round>,
    /// (round, sequence) -> player, for bounded pagination of commitments.
    participants: LookupMap<(u64, u32), AccountId>,
    commitments: LookupMap<(u64, AccountId), Commitment>,
    /// (player, crowbar serial) -> round in which it was consumed.
    crowbar_uses: LookupMap<(AccountId, u32), u64>,
    round_count: u64,
    profile_count: u64,
    unallocated_game_budget: u128,
    reserved_prizes: u128,
    cumulative_rewards_paid: u128,
    cumulative_expired_pots_burned: u128,
    cumulative_crafting_burned: u128,
    cumulative_storage_burned: u128,
    cumulative_resolver_burned: u128,
}

fn emit(event: &str, data: Value) {
    let payload = json!({ "standard": "bag_heist", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).unwrap_or_else(|| env::panic_str("ARITHMETIC_OVERFLOW"))
}

fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b).unwrap_or_else(|| env::panic_str("ARITHMETIC_UNDERFLOW"))
}

fn inc(value: u32) -> u32 {
    value.checked_add(1).unwrap_or_else(|| env::panic_str("COUNTER_OVERFLOW"))
}

fn require_exact_deposit(expected: u128, error: &str) {
    require!(env::attached_deposit().as_yoctonear() == expected, error);
}

#[near]
impl BagHeist {
    /// Mints the fixed supply to the contract treasury. Private: only the
    /// contract account can initialize, normally in the deploy transaction.
    #[init]
    #[private]
    pub fn new() -> Self {
        let treasury = env::current_account_id();
        let mut token = FungibleToken::new(StorageKey::FungibleToken);
        token.internal_register_account(&treasury);
        token.internal_deposit(&treasury, INITIAL_SUPPLY);
        FtMint { owner_id: &treasury, amount: U128(INITIAL_SUPPLY), memo: Some("BAG HEIST fixed supply") }.emit();
        Self {
            token,
            profiles: LookupMap::new(StorageKey::Profiles),
            rounds: LookupMap::new(StorageKey::Rounds),
            participants: LookupMap::new(StorageKey::Participants),
            commitments: LookupMap::new(StorageKey::Commitments),
            crowbar_uses: LookupMap::new(StorageKey::CrowbarUses),
            round_count: 0,
            profile_count: 0,
            unallocated_game_budget: INITIAL_SUPPLY,
            reserved_prizes: 0,
            cumulative_rewards_paid: 0,
            cumulative_expired_pots_burned: 0,
            cumulative_crafting_burned: 0,
            cumulative_storage_burned: 0,
            cumulative_resolver_burned: 0,
        }
    }

    // ------------------------------------------------------------------ game

    /// Creates the caller's game profile (crowbar inventory and stats).
    /// Separate from NEP-145 token storage registration.
    #[payable]
    pub fn register_profile(&mut self) -> ProfileView {
        require_exact_deposit(PROFILE_DEPOSIT, "PROFILE_DEPOSIT_MUST_BE_EXACT");
        let player = env::predecessor_account_id();
        require!(player != env::current_account_id(), "TREASURY_CANNOT_PLAY");
        require!(!self.profiles.contains_key(&player), "PROFILE_EXISTS");
        let usage = env::storage_usage();
        let profile = Profile { registered_at: env::block_timestamp(), ..Default::default() };
        self.profiles.insert(player.clone(), profile.clone());
        self.profile_count = self.profile_count.checked_add(1).unwrap_or_else(|| env::panic_str("COUNTER_OVERFLOW"));
        self.require_storage_covered(usage, 0, PROFILE_DEPOSIT);
        emit("profile_registered", json!({ "player_id": player }));
        profile.view(player)
    }

    /// Opens the next round. Permissionless; reserves exactly one prize.
    #[payable]
    pub fn open_round(&mut self) -> RoundView {
        require_exact_deposit(ROUND_DEPOSIT, "ROUND_DEPOSIT_MUST_BE_EXACT");
        if self.round_count > 0 {
            let previous = self.rounds.get(&self.round_count).unwrap_or_else(|| env::panic_str("ROUND_MISSING"));
            require!(previous.finalized_at.is_some(), "PREVIOUS_ROUND_NOT_FINALIZED");
        }
        require!(self.unallocated_game_budget >= ROUND_PRIZE, "GAME_BUDGET_EXHAUSTED");
        self.assert_treasury_covers_budget();

        let usage = env::storage_usage();
        let id = self.round_count.checked_add(1).unwrap_or_else(|| env::panic_str("ROUND_ID_OVERFLOW"));
        let contract = env::current_account_id();
        let (board, template, transform) = generate_board(&contract, id);
        let opened_at = env::block_timestamp();
        let commitment_end = opened_at.checked_add(COMMITMENT_WINDOW_NS).unwrap_or_else(|| env::panic_str("TIME_OVERFLOW"));
        let reveal_end = commitment_end.checked_add(REVEAL_WINDOW_NS).unwrap_or_else(|| env::panic_str("TIME_OVERFLOW"));
        let round = Round {
            id,
            template,
            transform,
            board_hash: board_hash(&board),
            board,
            opened_by: env::predecessor_account_id(),
            opened_at,
            commitment_end,
            reveal_end,
            participants: 0,
            valid_reveals: 0,
            invalid_reveals: 0,
            best: None,
            finalized_at: None,
            winner: None,
            claimed: false,
            burned: false,
        };
        self.unallocated_game_budget = sub(self.unallocated_game_budget, ROUND_PRIZE);
        self.reserved_prizes = add(self.reserved_prizes, ROUND_PRIZE);
        self.round_count = id;
        self.rounds.insert(id, round.clone());
        self.require_storage_covered(usage, ROUND_GROWTH_RESERVE, ROUND_DEPOSIT);

        emit("round_opened", json!({
            "round_id": U64(id),
            "opened_by": round.opened_by,
            "template": template,
            "transform": transform,
            "board_hash": hex(&round.board_hash),
            "opened_at": U64(opened_at),
            "commitment_end": U64(commitment_end),
            "reveal_end": U64(reveal_end),
            "prize": U128(ROUND_PRIZE),
        }));
        round.view(opened_at, ROUND_PRIZE)
    }

    /// Seals a route. `commitment_hash` is lowercase hex SHA-256 of the
    /// preimage in RULES.md. A crowbar, if requested, is consumed here and is
    /// not returned, even if its owner never reveals.
    #[payable]
    pub fn commit_solution(&mut self, round_id: U64, commitment_hash: String, use_crowbar: bool) -> CommitmentView {
        require_exact_deposit(COMMITMENT_DEPOSIT, "COMMITMENT_DEPOSIT_MUST_BE_EXACT");
        let hash = parse_hex32(&commitment_hash).unwrap_or_else(|| env::panic_str("COMMITMENT_HASH_MUST_BE_64_LOWERCASE_HEX"));
        let round_id = round_id.0;
        let mut round = self.rounds.get(&round_id).cloned().unwrap_or_else(|| env::panic_str("ROUND_NOT_FOUND"));
        let now = env::block_timestamp();
        require!(round.finalized_at.is_none() && now < round.commitment_end, "COMMITMENT_WINDOW_CLOSED");
        let player = env::predecessor_account_id();
        let mut profile = self.profiles.get(&player).cloned().unwrap_or_else(|| env::panic_str("PROFILE_NOT_REGISTERED"));
        require!(!self.commitments.contains_key(&(round_id, player.clone())), "ALREADY_COMMITTED");
        require!(round.participants < MAX_PARTICIPANTS, "ROUND_FULL");

        let usage = env::storage_usage();
        let sequence = inc(round.participants);
        let crowbar_serial = if use_crowbar {
            require!(profile.crowbars > 0, "NO_CROWBAR_IN_INVENTORY");
            profile.crowbars -= 1;
            profile.consumed = inc(profile.consumed);
            self.crowbar_uses.insert((player.clone(), profile.consumed), round_id);
            Some(profile.consumed)
        } else {
            None
        };
        profile.rounds_played = inc(profile.rounds_played);
        round.participants = sequence;
        let commitment = Commitment { hash, use_crowbar, crowbar_serial, sequence, committed_at: now, reveal: None };
        self.commitments.insert((round_id, player.clone()), commitment.clone());
        self.participants.insert((round_id, sequence), player.clone());
        self.profiles.insert(player.clone(), profile.clone());
        self.rounds.insert(round_id, round);
        self.require_storage_covered(usage, REVEAL_GROWTH_RESERVE, COMMITMENT_DEPOSIT);

        if let Some(serial) = crowbar_serial {
            emit("crowbar_consumed", json!({
                "round_id": U64(round_id),
                "player_id": player,
                "serial": serial,
                "crowbars_left": profile.crowbars,
            }));
        }
        emit("solution_committed", json!({
            "round_id": U64(round_id),
            "player_id": player,
            "sequence": sequence,
            "use_crowbar": use_crowbar,
            "commitment_hash": commitment_hash,
        }));
        commitment.view(round_id, player)
    }

    /// Opens a sealed route. A hash mismatch rejects the call and changes
    /// nothing. A matching hash records the result, valid or not, for good.
    pub fn reveal_solution(&mut self, round_id: U64, moves: String, salt: String) -> RevealView {
        require!(moves.len() <= MAX_MOVES, "ROUTE_TOO_LONG");
        let salt_bytes = parse_hex32(&salt).unwrap_or_else(|| env::panic_str("SALT_MUST_BE_64_LOWERCASE_HEX"));
        let round_id = round_id.0;
        let mut round = self.rounds.get(&round_id).cloned().unwrap_or_else(|| env::panic_str("ROUND_NOT_FOUND"));
        let now = env::block_timestamp();
        require!(now >= round.commitment_end, "REVEAL_WINDOW_NOT_OPEN");
        require!(now < round.reveal_end && round.finalized_at.is_none(), "REVEAL_WINDOW_CLOSED");
        let player = env::predecessor_account_id();
        let key = (round_id, player.clone());
        let mut commitment = self.commitments.get(&key).cloned().unwrap_or_else(|| env::panic_str("NO_COMMITMENT_FOR_CALLER"));
        require!(commitment.reveal.is_none(), "ALREADY_REVEALED");

        let contract = env::current_account_id();
        let digest = commitment_digest(&CommitmentInput {
            contract: contract.as_str(),
            player: player.as_str(),
            round: round_id,
            board_hash: &round.board_hash,
            use_crowbar: commitment.use_crowbar,
            moves: &moves,
            salt: &salt_bytes,
        });
        require!(digest == commitment.hash, "COMMITMENT_MISMATCH");

        let check = board::check_route(&round.board, &moves, commitment.use_crowbar);
        let reveal = Reveal {
            verdict: check.verdict,
            loot: check.loot,
            length: check.length,
            doors: check.doors,
            moves,
            revealed_at: now,
        };
        let mut leads = false;
        if check.valid {
            round.valid_reveals = inc(round.valid_reveals);
            let score = Score { player_id: player.clone(), loot: check.loot, length: check.length, sequence: commitment.sequence };
            if round.best.as_ref().is_none_or(|best| score.beats(best)) {
                round.best = Some(score);
                leads = true;
            }
            let mut profile = self.profiles.get(&player).cloned().unwrap_or_else(|| env::panic_str("PROFILE_NOT_REGISTERED"));
            profile.valid_reveals = inc(profile.valid_reveals);
            self.profiles.insert(player.clone(), profile);
        } else {
            round.invalid_reveals = inc(round.invalid_reveals);
        }
        commitment.reveal = Some(reveal.clone());
        self.commitments.insert(key, commitment.clone());
        self.rounds.insert(round_id, round);

        emit("solution_revealed", json!({
            "round_id": U64(round_id),
            "player_id": player,
            "sequence": commitment.sequence,
            "valid": check.valid,
            "verdict": check.verdict,
            "loot": check.loot,
            "length": check.length,
            "doors": check.doors,
            "leads": leads,
        }));
        reveal.view()
    }

    /// Settles a round once its reveal window has ended. Permissionless and
    /// O(1): the best reveal was maintained as reveals arrived.
    pub fn finalize_round(&mut self, round_id: U64) -> RoundView {
        let round_id = round_id.0;
        let mut round = self.rounds.get(&round_id).cloned().unwrap_or_else(|| env::panic_str("ROUND_NOT_FOUND"));
        require!(round.finalized_at.is_none(), "ALREADY_FINALIZED");
        let now = env::block_timestamp();
        require!(now >= round.reveal_end, "REVEAL_WINDOW_STILL_OPEN");
        round.finalized_at = Some(now);

        if let Some(best) = round.best.clone() {
            round.winner = Some(best.player_id.clone());
            let mut profile = self.profiles.get(&best.player_id).cloned().unwrap_or_else(|| env::panic_str("PROFILE_NOT_REGISTERED"));
            profile.wins = inc(profile.wins);
            self.profiles.insert(best.player_id.clone(), profile);
            emit("round_finalized", json!({
                "round_id": U64(round_id),
                "outcome": "winner",
                "winner": best.player_id,
                "loot": best.loot,
                "length": best.length,
                "sequence": best.sequence,
                "prize": U128(ROUND_PRIZE),
                "valid_reveals": round.valid_reveals,
                "participants": round.participants,
            }));
        } else {
            round.burned = true;
            self.reserved_prizes = sub(self.reserved_prizes, ROUND_PRIZE);
            self.cumulative_expired_pots_burned = add(self.cumulative_expired_pots_burned, ROUND_PRIZE);
            let treasury = env::current_account_id();
            self.token.internal_withdraw(&treasury, ROUND_PRIZE);
            FtBurn { owner_id: &treasury, amount: U128(ROUND_PRIZE), memo: Some("expired round pot") }.emit();
            emit("round_finalized", json!({
                "round_id": U64(round_id),
                "outcome": "burned",
                "burned": U128(ROUND_PRIZE),
                "valid_reveals": 0,
                "participants": round.participants,
            }));
        }
        self.rounds.insert(round_id, round.clone());
        round.view(now, ROUND_PRIZE)
    }

    /// Pays the recorded winner from the treasury. If the winner is not
    /// registered for BAG storage the call fails and the prize stays reserved.
    #[payable]
    pub fn claim_reward(&mut self, round_id: U64) -> U128 {
        assert_one_yocto();
        let round_id = round_id.0;
        let mut round = self.rounds.get(&round_id).cloned().unwrap_or_else(|| env::panic_str("ROUND_NOT_FOUND"));
        require!(round.finalized_at.is_some(), "ROUND_NOT_FINALIZED");
        let caller = env::predecessor_account_id();
        require!(round.winner.as_ref() == Some(&caller), "NOT_THE_WINNER");
        require!(!round.claimed, "ALREADY_CLAIMED");
        require!(self.token.accounts.contains_key(&caller), "REGISTER_BAG_STORAGE_FIRST");

        round.claimed = true;
        self.reserved_prizes = sub(self.reserved_prizes, ROUND_PRIZE);
        self.cumulative_rewards_paid = add(self.cumulative_rewards_paid, ROUND_PRIZE);
        let treasury = env::current_account_id();
        self.token.internal_transfer(&treasury, &caller, ROUND_PRIZE, Some("BAG HEIST round prize".to_string()));
        let mut profile = self.profiles.get(&caller).cloned().unwrap_or_else(|| env::panic_str("PROFILE_NOT_REGISTERED"));
        profile.bag_won = add(profile.bag_won, ROUND_PRIZE);
        self.profiles.insert(caller.clone(), profile);
        self.rounds.insert(round_id, round);

        emit("reward_claimed", json!({ "round_id": U64(round_id), "winner": caller, "amount": U128(ROUND_PRIZE) }));
        U128(ROUND_PRIZE)
    }

    /// Burns 5 BAG from the caller and adds one crowbar to their inventory.
    #[payable]
    pub fn craft_crowbar(&mut self) -> ProfileView {
        assert_one_yocto();
        let player = env::predecessor_account_id();
        let mut profile = self.profiles.get(&player).cloned().unwrap_or_else(|| env::panic_str("PROFILE_NOT_REGISTERED"));
        require!(profile.crowbars < MAX_CROWBARS, "CROWBAR_INVENTORY_FULL");
        let balance = self.token.accounts.get(&player).unwrap_or(0);
        require!(balance >= CROWBAR_PRICE, "NOT_ENOUGH_BAG");

        self.token.internal_withdraw(&player, CROWBAR_PRICE);
        FtBurn { owner_id: &player, amount: U128(CROWBAR_PRICE), memo: Some("crowbar crafted") }.emit();
        self.cumulative_crafting_burned = add(self.cumulative_crafting_burned, CROWBAR_PRICE);
        profile.crowbars += 1;
        profile.crafted = inc(profile.crafted);
        self.profiles.insert(player.clone(), profile.clone());

        emit("crowbar_crafted", json!({
            "player_id": player,
            "serial": profile.crafted,
            "burned": U128(CROWBAR_PRICE),
            "crowbars": profile.crowbars,
        }));
        profile.view(player)
    }

    // ----------------------------------------------------------------- views

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            network: NETWORK.to_string(),
            contract_id: env::current_account_id(),
            token_name: TOKEN_NAME.to_string(),
            token_symbol: TOKEN_SYMBOL.to_string(),
            decimals: DECIMALS,
            initial_supply: U128(INITIAL_SUPPLY),
            round_prize: U128(ROUND_PRIZE),
            crowbar_price: U128(CROWBAR_PRICE),
            commitment_window_ns: U64(COMMITMENT_WINDOW_NS),
            reveal_window_ns: U64(REVEAL_WINDOW_NS),
            board_size: SIZE as u8,
            max_route_length: MAX_MOVES as u8,
            max_participants: MAX_PARTICIPANTS,
            max_crowbars: MAX_CROWBARS,
            template_count: TEMPLATES.len() as u8,
            profile_deposit: U128(PROFILE_DEPOSIT),
            round_deposit: U128(ROUND_DEPOSIT),
            commitment_deposit: U128(COMMITMENT_DEPOSIT),
            storage_deposits_retained: true,
        }
    }

    pub fn get_state(&self) -> StateView {
        let treasury = self.treasury_balance();
        let now = env::block_timestamp();
        let current = if self.round_count > 0 { self.rounds.get(&self.round_count) } else { None };
        let burns = [
            self.cumulative_expired_pots_burned,
            self.cumulative_crafting_burned,
            self.cumulative_storage_burned,
            self.cumulative_resolver_burned,
        ];
        let supply_plus_burns = burns.iter().try_fold(self.token.total_supply, |acc, burn| acc.checked_add(*burn));
        let budget_total = [self.reserved_prizes, self.cumulative_rewards_paid, self.cumulative_expired_pots_burned]
            .iter()
            .try_fold(self.unallocated_game_budget, |acc, value| acc.checked_add(*value));
        StateView {
            round_count: U64(self.round_count),
            current_round_id: current.map(|round| U64(round.id)),
            current_phase: current.map(|round| round.phase(now)),
            profile_count: U64(self.profile_count),
            total_supply: U128(self.token.total_supply),
            treasury_balance: U128(treasury),
            unallocated_game_budget: U128(self.unallocated_game_budget),
            reserved_prizes: U128(self.reserved_prizes),
            cumulative_rewards_paid: U128(self.cumulative_rewards_paid),
            cumulative_expired_pots_burned: U128(self.cumulative_expired_pots_burned),
            cumulative_crafting_burned: U128(self.cumulative_crafting_burned),
            cumulative_storage_burned: U128(self.cumulative_storage_burned),
            cumulative_resolver_burned: U128(self.cumulative_resolver_burned),
            budget_identity_holds: budget_total == Some(INITIAL_SUPPLY),
            treasury_covers_budget: self.unallocated_game_budget.checked_add(self.reserved_prizes).is_some_and(|need| treasury >= need),
            supply_audit_holds: supply_plus_burns == Some(INITIAL_SUPPLY),
            block_timestamp: U64(now),
            block_height: U64(env::block_height()),
        }
    }

    pub fn get_round(&self, round_id: U64) -> Option<RoundView> {
        self.rounds.get(&round_id.0).map(|round| round.view(env::block_timestamp(), ROUND_PRIZE))
    }

    /// Rounds in ascending id order starting at `from_id` (default 1), at most 25.
    pub fn get_rounds(&self, from_id: Option<U64>, limit: Option<u32>) -> Vec<RoundView> {
        let start = from_id.map_or(1, |id| id.0.max(1));
        let limit = u64::from(limit.unwrap_or(10).min(25));
        let now = env::block_timestamp();
        (start..start.saturating_add(limit))
            .take_while(|id| *id <= self.round_count)
            .filter_map(|id| self.rounds.get(&id).map(|round| round.view(now, ROUND_PRIZE)))
            .collect()
    }

    pub fn get_profile(&self, account_id: AccountId) -> Option<ProfileView> {
        self.profiles.get(&account_id).map(|profile| profile.view(account_id.clone()))
    }

    pub fn get_commitment(&self, round_id: U64, account_id: AccountId) -> Option<CommitmentView> {
        self.commitments
            .get(&(round_id.0, account_id.clone()))
            .map(|commitment| commitment.view(round_id.0, account_id))
    }

    /// Commitments in sequence order starting at `from_sequence` (default 1), at most 64.
    pub fn get_commitments(&self, round_id: U64, from_sequence: Option<u32>, limit: Option<u32>) -> Vec<CommitmentView> {
        let start = from_sequence.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(MAX_PARTICIPANTS).min(MAX_PARTICIPANTS);
        (start..start.saturating_add(limit))
            .map_while(|sequence| self.participants.get(&(round_id.0, sequence)))
            .filter_map(|player| self.get_commitment(round_id, player.clone()))
            .collect()
    }

    /// Runs the on-chain route checker against a round's board without
    /// changing state. Useful for previewing a route before committing.
    pub fn check_route(&self, round_id: U64, moves: String, use_crowbar: bool) -> RouteCheck {
        require!(moves.len() <= 64, "ROUTE_TOO_LONG");
        let round = self.rounds.get(&round_id.0).unwrap_or_else(|| env::panic_str("ROUND_NOT_FOUND"));
        board::check_route(&round.board, &moves, use_crowbar)
    }

    pub fn get_crowbar(&self, account_id: AccountId, serial: u32) -> Option<CrowbarView> {
        let profile = self.profiles.get(&account_id)?;
        if serial == 0 || serial > profile.crafted {
            return None;
        }
        let consumed_in_round = self.crowbar_uses.get(&(account_id.clone(), serial)).copied();
        Some(CrowbarView {
            owner_id: account_id,
            serial,
            status: if consumed_in_round.is_some() { CrowbarStatus::Consumed } else { CrowbarStatus::Ready },
            consumed_in_round: consumed_in_round.map(U64),
        })
    }

    /// Crowbars in serial order starting at `from_serial` (default 1), at most 50.
    pub fn get_crowbars(&self, account_id: AccountId, from_serial: Option<u32>, limit: Option<u32>) -> Vec<CrowbarView> {
        let start = from_serial.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(50).min(50);
        (start..start.saturating_add(limit))
            .map_while(|serial| self.get_crowbar(account_id.clone(), serial))
            .collect()
    }

    // --------------------------------------------------------------- helpers

    fn treasury_balance(&self) -> u128 {
        self.token.accounts.get(&env::current_account_id()).unwrap_or(0)
    }

    fn assert_treasury_covers_budget(&self) {
        let need = add(self.unallocated_game_budget, self.reserved_prizes);
        require!(self.treasury_balance() >= need, "TREASURY_MUST_COVER_GAME_BUDGET");
    }

    /// A full-access key on the contract account can sign token transfers
    /// from the treasury. Only the excess above the committed game budget
    /// (for example, donations) may leave it.
    fn assert_treasury_can_send(&self, amount: u128) {
        if env::predecessor_account_id() == env::current_account_id() {
            let need = add(self.unallocated_game_budget, self.reserved_prizes);
            let after = self.treasury_balance().checked_sub(amount);
            require!(after.is_some_and(|left| left >= need), "TREASURY_MUST_COVER_GAME_BUDGET");
        }
    }

    fn flush(&mut self) {
        self.profiles.flush();
        self.rounds.flush();
        self.participants.flush();
        self.commitments.flush();
        self.crowbar_uses.flush();
    }

    /// Fails the call unless `deposit` pays for the bytes written so far plus
    /// `reserve` bytes of guaranteed later growth.
    fn require_storage_covered(&mut self, usage_before: u64, reserve: u64, deposit: u128) {
        self.flush();
        let used = env::storage_usage().saturating_sub(usage_before).saturating_add(reserve);
        let cost = u128::from(used).saturating_mul(env::storage_byte_cost().as_yoctonear());
        require!(cost <= deposit, "STORAGE_DEPOSIT_TOO_LOW");
    }
}

// ----------------------------------------------------------- NEP-141 / 145 / 148

#[near]
impl FungibleTokenCore for BagHeist {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.assert_treasury_can_send(amount.0);
        self.token.ft_transfer(receiver_id, amount, memo);
    }

    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.assert_treasury_can_send(amount.0);
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for BagHeist {
    /// Standard resolver. The library emits `ft_burn` itself when a refund
    /// cannot be returned; the burn is also added to the supply audit.
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            self.cumulative_resolver_burned = add(self.cumulative_resolver_burned, burned);
        }
        used.into()
    }
}

#[near]
impl StorageManagement for BagHeist {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    /// Standard unregistration. A forced unregistration burns the remaining
    /// balance; this contract emits the matching `ft_burn` and records it.
    /// The treasury account can never unregister.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        require!(env::predecessor_account_id() != env::current_account_id(), "TREASURY_CANNOT_UNREGISTER");
        match self.token.internal_storage_unregister(force) {
            Some((account_id, balance)) => {
                if balance > 0 {
                    self.cumulative_storage_burned = add(self.cumulative_storage_burned, balance);
                    FtBurn { owner_id: &account_id, amount: U128(balance), memo: Some("forced storage unregister") }.emit();
                }
                true
            }
            None => false,
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for BagHeist {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: TOKEN_NAME.to_string(),
            symbol: TOKEN_SYMBOL.to_string(),
            icon: Some(BAG_ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }
}
