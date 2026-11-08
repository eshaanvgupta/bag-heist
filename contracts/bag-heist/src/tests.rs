//! Unit tests. They run the contract against near-sdk's mocked blockchain,
//! which accounts storage exactly like nearcore (key + value + 40 bytes).

use super::*;
use near_sdk::mock::MockedBlockchain;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig, VMContext};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

const T0: u64 = 1_800_000_000_000_000_000;
const ONE_YOCTO: u128 = 1;
const FT_STORAGE: u128 = 2_000_000_000_000_000_000_000;

thread_local! {
    static CONTEXT: RefCell<Option<VMContext>> = const { RefCell::new(None) };
    static EXPECTING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn quiet_expected_panics() {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // Silence only panics a test deliberately provokes (see `guarded`).
            if !EXPECTING.with(|e| e.get()) {
                default(info);
            }
        }));
    });
}

fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn id(name: &str) -> AccountId {
    name.parse().unwrap()
}
fn contract_id() -> AccountId {
    id("bag-heist.testnet")
}
fn alice() -> AccountId {
    id("alice.testnet")
}
fn bob() -> AccountId {
    id("bob.testnet")
}
fn carol() -> AccountId {
    id("carol.testnet")
}

fn set(caller: &AccountId, deposit: u128, now: u64) {
    set_with(caller, deposit, now, vec![]);
}

fn set_with(caller: &AccountId, deposit: u128, now: u64, results: Vec<PromiseResult>) {
    quiet_expected_panics();
    let context = VMContextBuilder::new()
        .current_account_id(contract_id())
        .signer_account_id(caller.clone())
        .predecessor_account_id(caller.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .build();
    CONTEXT.with(|c| *c.borrow_mut() = Some(context.clone()));
    testing_env!(context, test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

/// Runs `f`, expecting a panic containing `message`. Validation in the
/// contract happens before any write, so no state needs restoring.
fn expect_panic<F: FnOnce()>(message: &str, f: F) {
    quiet_expected_panics();
    let outcome = guarded(f);
    match outcome {
        Ok(()) => panic!("expected panic containing {message:?}, call succeeded"),
        Err(payload) => {
            let text = panic_text(payload.as_ref());
            assert!(text.contains(message), "expected {message:?}, got {text:?}");
        }
    }
}

/// Runs a call that may legitimately panic, without printing the panic.
fn guarded<R, F: FnOnce() -> R>(f: F) -> std::thread::Result<R> {
    quiet_expected_panics();
    EXPECTING.with(|e| e.set(true));
    let result = catch_unwind(AssertUnwindSafe(f));
    EXPECTING.with(|e| e.set(false));
    result
}

fn deploy() -> BagHeist {
    set(&contract_id(), 0, T0);
    install(HashMap::new());
    BagHeist::new()
}

fn register(c: &mut BagHeist, who: &AccountId) {
    set(who, PROFILE_DEPOSIT, T0);
    c.register_profile();
}

fn ft_register(c: &mut BagHeist, who: &AccountId) {
    set(who, FT_STORAGE, T0);
    c.storage_deposit(None, None);
}

fn open(c: &mut BagHeist, who: &AccountId, now: u64) -> RoundView {
    set(who, ROUND_DEPOSIT, now);
    c.open_round()
}

fn salt_for(tag: u8) -> String {
    hex(&[tag; 32])
}

fn commitment_hex(contract: &AccountId, player: &AccountId, round: u64, board_hash: &str, crowbar: bool, moves: &str, salt: &str) -> String {
    hex(&commitment_digest(&CommitmentInput {
        contract: contract.as_str(),
        player: player.as_str(),
        round,
        board_hash: &parse_hex32(board_hash).unwrap(),
        use_crowbar: crowbar,
        moves,
        salt: &parse_hex32(salt).unwrap(),
    }))
}

fn commit(c: &mut BagHeist, who: &AccountId, round: &RoundView, moves: &str, salt: &str, crowbar: bool, now: u64) -> CommitmentView {
    let hash = commitment_hex(&contract_id(), who, round.id.0, &round.board_hash, crowbar, moves, salt);
    set(who, COMMITMENT_DEPOSIT, now);
    c.commit_solution(round.id, hash, crowbar)
}

fn reveal(c: &mut BagHeist, who: &AccountId, round: &RoundView, moves: &str, salt: &str, now: u64) -> RevealView {
    set(who, 0, now);
    c.reveal_solution(round.id, moves.to_string(), salt.to_string())
}

fn finalize(c: &mut BagHeist, round: &RoundView, now: u64) -> RoundView {
    set(&carol(), 0, now);
    c.finalize_round(round.id)
}

fn claim(c: &mut BagHeist, who: &AccountId, round: &RoundView, now: u64) -> U128 {
    set(who, ONE_YOCTO, now);
    c.claim_reward(round.id)
}

fn reveal_time(round: &RoundView) -> u64 {
    round.commitment_end.0
}

fn settle_time(round: &RoundView) -> u64 {
    round.reveal_end.0
}

/// Every route from start to exit, sorted by loot desc, length asc, moves.
fn solve(board: &Board, crowbar: bool) -> Vec<(String, u16, u16)> {
    fn walk(board: &Board, tile: usize, moves: &mut String, seen: u64, doors: u8, crowbar: bool, out: &mut Vec<String>) {
        if tile == usize::from(board.exit) {
            out.push(moves.clone());
            return;
        }
        if moves.len() == MAX_MOVES {
            return;
        }
        let (row, column) = (tile / SIZE, tile % SIZE);
        for (m, ok, next) in [
            ('U', row > 0, tile.wrapping_sub(SIZE)),
            ('D', row < SIZE - 1, tile + SIZE),
            ('L', column > 0, tile.wrapping_sub(1)),
            ('R', column < SIZE - 1, tile + 1),
        ] {
            if !ok || board.tiles[next] == TILE_WALL || seen & (1 << next) != 0 {
                continue;
            }
            let door = u8::from(board.tiles[next] == TILE_DOOR);
            if doors + door > u8::from(crowbar) {
                continue;
            }
            moves.push(m);
            walk(board, next, moves, seen | (1 << next), doors + door, crowbar, out);
            moves.pop();
        }
    }
    let mut out = vec![];
    walk(board, usize::from(board.start), &mut String::new(), 1 << board.start, 0, crowbar, &mut out);
    let mut scored: Vec<_> = out
        .into_iter()
        .map(|moves| {
            let check = check_route(board, &moves, crowbar);
            assert!(check.valid);
            (moves, check.loot, check.length)
        })
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)).then(a.0.cmp(&b.0)));
    scored
}

fn state(c: &BagHeist) -> StateView {
    c.get_state()
}

fn assert_invariants(c: &BagHeist, accounts: &[AccountId]) {
    let s = state(c);
    assert!(s.budget_identity_holds, "budget identity");
    assert!(s.treasury_covers_budget, "treasury coverage");
    assert!(s.supply_audit_holds, "supply audit");
    let mut sum = c.ft_balance_of(contract_id()).0;
    for account in accounts {
        sum += c.ft_balance_of(account.clone()).0;
    }
    assert_eq!(sum, s.total_supply.0, "sum of balances equals total supply");
}

// ------------------------------------------------------------- shared fixtures

#[test]
fn templates_match_fixture_and_every_board_is_fair() {
    let json: Vec<Vec<String>> = near_sdk::serde_json::from_str(include_str!("../../../fixtures/templates.json")).unwrap();
    assert_eq!(json.len(), TEMPLATES.len());
    set(&contract_id(), 0, T0);
    for (index, rows) in TEMPLATES.iter().enumerate() {
        assert_eq!(json[index], rows.iter().map(|r| r.to_string()).collect::<Vec<_>>());
        for t in 0..8 {
            let board = transform(&template(index), t);
            let plain = solve(&board, false);
            let barred = solve(&board, true);
            assert!(!plain.is_empty(), "template {index}/{t} needs a crowbar-free route");
            let best_door = barred.iter().find(|(m, _, _)| check_route(&board, m, true).doors == 1).unwrap();
            assert!(best_door.1 > plain[0].1, "template {index}/{t} door route must beat the plain route");
            assert_eq!(board.loot[usize::from(board.start)], 0);
            assert_eq!(board.tiles[usize::from(board.exit)], TILE_OPEN);
        }
    }
}

#[test]
fn shared_vectors_agree_with_typescript() {
    let data: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(include_str!("../../../fixtures/vectors.json")).unwrap();
    set(&contract_id(), 0, T0);
    for b in data["boards"].as_array().unwrap() {
        let contract = id(b["contractId"].as_str().unwrap());
        let round: u64 = b["roundId"].as_str().unwrap().parse().unwrap();
        let (board, template_index, transform_index) = generate_board(&contract, round);
        assert_eq!(hex(&generation_seed(&contract, round)), b["seed"].as_str().unwrap());
        assert_eq!(template_index, b["template"].as_u64().unwrap() as u8);
        assert_eq!(transform_index, b["transform"].as_u64().unwrap() as u8);
        assert_eq!(board.start, b["board"]["start"].as_u64().unwrap() as u8);
        assert_eq!(board.exit, b["board"]["exit"].as_u64().unwrap() as u8);
        assert_eq!(hex(&board_bytes(&board)), b["preimage"].as_str().unwrap());
        assert_eq!(hex(&board_hash(&board)), b["hash"].as_str().unwrap(), "board {} round {}", contract, round);
    }
    for v in data["commitments"].as_array().unwrap() {
        let i = &v["input"];
        let input = CommitmentInput {
            contract: i["contractId"].as_str().unwrap(),
            player: i["playerId"].as_str().unwrap(),
            round: i["roundId"].as_str().unwrap().parse().unwrap(),
            board_hash: &parse_hex32(i["boardHash"].as_str().unwrap()).unwrap(),
            use_crowbar: i["useCrowbar"].as_bool().unwrap(),
            moves: i["moves"].as_str().unwrap(),
            salt: &parse_hex32(i["salt"].as_str().unwrap()).unwrap(),
        };
        assert_eq!(hex(&commitment_bytes(&input)), v["preimage"].as_str().unwrap(), "{}", v["name"]);
        assert_eq!(hex(&commitment_digest(&input)), v["hash"].as_str().unwrap(), "{}", v["name"]);
    }
    let mut checked = 0;
    for group in ["routes", "differential"] {
        for r in data[group].as_array().unwrap() {
            let index = r["template"].as_u64().unwrap() as usize;
            let t = r["transform"].as_u64().unwrap() as u8;
            let board = transform(&template(index), t);
            let check = check_route(&board, r["moves"].as_str().unwrap(), r["crowbar"].as_bool().unwrap());
            let expected = &r["expected"];
            let verdict = near_sdk::serde_json::to_value(check.verdict).unwrap();
            assert_eq!(verdict, expected["verdict"], "{} {}", group, r["moves"]);
            assert_eq!(check.valid, expected["valid"].as_bool().unwrap());
            assert_eq!(u64::from(check.loot), expected["loot"].as_u64().unwrap());
            assert_eq!(u64::from(check.length), expected["length"].as_u64().unwrap());
            assert_eq!(u64::from(check.doors), expected["doors"].as_u64().unwrap());
            let path: Vec<u8> = expected["path"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
            assert_eq!(check.path, path);
            checked += 1;
        }
    }
    assert!(checked >= 500, "differential coverage: {checked}");
}

#[test]
fn route_checker_enforces_every_rule() {
    set(&contract_id(), 0, T0);
    let board = template(0);
    let verdict = |moves: &str, crowbar: bool| check_route(&board, moves, crowbar).verdict;
    assert_eq!(verdict("U", false), Verdict::OutOfBounds);
    assert_eq!(verdict("L", false), Verdict::OutOfBounds);
    assert_eq!(verdict("RDRRURRR", false), Verdict::OutOfBounds, "no wrap between rows");
    assert_eq!(verdict("D", false), Verdict::Wall);
    assert_eq!(verdict("RDU", false), Verdict::Revisit);
    assert_eq!(verdict("RDDDDRRDRRU", false), Verdict::PastExit);
    assert_eq!(verdict("RDDDR", false), Verdict::DoorLocked);
    assert_eq!(verdict("RDDDRDD", true), Verdict::SecondDoor);
    assert_eq!(verdict("RD", false), Verdict::NotAtExit);
    assert_eq!(verdict("", false), Verdict::NotAtExit);
    assert_eq!(verdict("Rx", false), Verdict::BadMove);
    assert_eq!(verdict("r", false), Verdict::BadMove);
    assert_eq!(verdict(&"R".repeat(36), false), Verdict::TooLong);
    let plain = check_route(&board, "RDDDDRRDRR", false);
    assert!(plain.valid);
    assert_eq!((plain.loot, plain.length, plain.doors), (19, 10, 0));
    let door = check_route(&board, "RDDDRRDDRR", true);
    assert!(door.valid);
    assert_eq!((door.loot, door.length, door.doors), (23, 10, 1));
}

// ----------------------------------------------------------------- lifecycle

#[test]
fn init_mints_fixed_supply_to_treasury() {
    let c = deploy();
    let s = state(&c);
    assert_eq!(s.total_supply.0, INITIAL_SUPPLY);
    assert_eq!(s.treasury_balance.0, INITIAL_SUPPLY);
    assert_eq!(s.unallocated_game_budget.0, INITIAL_SUPPLY);
    assert_eq!(s.reserved_prizes.0 + s.cumulative_rewards_paid.0 + s.cumulative_expired_pots_burned.0, 0);
    assert!(s.budget_identity_holds && s.treasury_covers_budget && s.supply_audit_holds);
    assert!(get_logs().iter().any(|l| l.contains("\"ft_mint\"") && l.contains("1000000000000")));
    let metadata = c.ft_metadata();
    assert_eq!((metadata.name.as_str(), metadata.symbol.as_str(), metadata.decimals), ("Bag Heist", "BAG", 6));
    let config = c.get_config();
    assert_eq!(config.round_prize.0, 100_000_000);
    assert_eq!(config.crowbar_price.0, 5_000_000);
    assert_eq!((config.board_size, config.max_route_length, config.max_participants, config.max_crowbars), (6, 35, 64, 10));
    assert_eq!(config.commitment_window_ns.0, 120_000_000_000);
    assert_eq!(config.reveal_window_ns.0, 120_000_000_000);
}

#[test]
fn profile_registration_rules() {
    let mut c = deploy();
    set(&alice(), PROFILE_DEPOSIT - 1, T0);
    expect_panic("PROFILE_DEPOSIT_MUST_BE_EXACT", || {
        c.register_profile();
    });
    register(&mut c, &alice());
    assert_eq!(c.get_profile(alice()).unwrap().crowbars, 0);
    set(&alice(), PROFILE_DEPOSIT, T0);
    expect_panic("PROFILE_EXISTS", || {
        c.register_profile();
    });
    set(&contract_id(), PROFILE_DEPOSIT, T0);
    expect_panic("TREASURY_CANNOT_PLAY", || {
        c.register_profile();
    });
    assert_eq!(state(&c).profile_count.0, 1);
    assert!(c.storage_balance_of(alice()).is_none(), "game profile is separate from FT storage");
}

#[test]
fn round_opening_reserves_one_prize_and_derives_board() {
    let mut c = deploy();
    set(&alice(), ROUND_DEPOSIT + 1, T0);
    expect_panic("ROUND_DEPOSIT_MUST_BE_EXACT", || {
        c.open_round();
    });
    let round = open(&mut c, &alice(), T0 + 5);
    let (board, template_index, transform_index) = generate_board(&contract_id(), 1);
    assert_eq!(round.board, board);
    assert_eq!((round.template, round.transform), (template_index, transform_index));
    assert_eq!(round.board_hash, hex(&board_hash(&board)));
    assert_eq!(round.commitment_end.0, T0 + 5 + COMMITMENT_WINDOW_NS);
    assert_eq!(round.reveal_end.0, T0 + 5 + COMMITMENT_WINDOW_NS + REVEAL_WINDOW_NS);
    assert_eq!(round.phase, Phase::Commit);
    let s = state(&c);
    assert_eq!(s.unallocated_game_budget.0, INITIAL_SUPPLY - ROUND_PRIZE);
    assert_eq!(s.reserved_prizes.0, ROUND_PRIZE);
    set(&bob(), ROUND_DEPOSIT, T0 + 6);
    expect_panic("PREVIOUS_ROUND_NOT_FINALIZED", || {
        c.open_round();
    });
}

#[test]
fn exact_phase_boundaries() {
    let mut c = deploy();
    register(&mut c, &alice());
    register(&mut c, &bob());
    let round = open(&mut c, &alice(), T0);
    let moves = solve(&round.board, false)[0].0.clone();
    let salt = salt_for(1);
    commit(&mut c, &alice(), &round, &moves, &salt, false, round.commitment_end.0 - 1);
    let hash = commitment_hex(&contract_id(), &bob(), 1, &round.board_hash, false, &moves, &salt_for(2));
    set(&bob(), COMMITMENT_DEPOSIT, round.commitment_end.0);
    expect_panic("COMMITMENT_WINDOW_CLOSED", || {
        c.commit_solution(round.id, hash, false);
    });
    set(&alice(), 0, round.commitment_end.0 - 1);
    expect_panic("REVEAL_WINDOW_NOT_OPEN", || {
        c.reveal_solution(round.id, moves.clone(), salt.clone());
    });
    set(&carol(), 0, round.reveal_end.0 - 1);
    expect_panic("REVEAL_WINDOW_STILL_OPEN", || {
        c.finalize_round(round.id);
    });
    let result = reveal(&mut c, &alice(), &round, &moves, &salt, round.reveal_end.0 - 1);
    assert!(result.valid);
    assert_eq!(c.get_round(round.id).unwrap().phase, Phase::Reveal);
    let settled = finalize(&mut c, &round, round.reveal_end.0);
    assert_eq!(settled.winner, Some(alice()));
    set(&carol(), 0, round.reveal_end.0 + 1);
    expect_panic("ALREADY_FINALIZED", || {
        c.finalize_round(round.id);
    });
}

#[test]
fn reveal_at_reveal_end_is_rejected() {
    let mut c = deploy();
    register(&mut c, &alice());
    let round = open(&mut c, &alice(), T0);
    let moves = solve(&round.board, false)[0].0.clone();
    commit(&mut c, &alice(), &round, &moves, &salt_for(1), false, T0 + 1);
    set(&alice(), 0, round.reveal_end.0);
    expect_panic("REVEAL_WINDOW_CLOSED", || {
        c.reveal_solution(round.id, moves.clone(), salt_for(1));
    });
}

#[test]
fn commitment_input_validation_and_duplicates() {
    let mut c = deploy();
    register(&mut c, &alice());
    let round = open(&mut c, &alice(), T0);
    for bad in ["A".repeat(64), "a".repeat(63), "g".repeat(64), format!("0x{}", "a".repeat(62))] {
        set(&alice(), COMMITMENT_DEPOSIT, T0 + 1);
        expect_panic("COMMITMENT_HASH_MUST_BE_64_LOWERCASE_HEX", || {
            c.commit_solution(round.id, bad.clone(), false);
        });
    }
    set(&bob(), COMMITMENT_DEPOSIT, T0 + 1);
    expect_panic("PROFILE_NOT_REGISTERED", || {
        c.commit_solution(round.id, "a".repeat(64), false);
    });
    set(&alice(), COMMITMENT_DEPOSIT, T0 + 1);
    expect_panic("NO_CROWBAR_IN_INVENTORY", || {
        c.commit_solution(round.id, "a".repeat(64), true);
    });
    set(&alice(), COMMITMENT_DEPOSIT, T0 + 1);
    let first = c.commit_solution(round.id, "a".repeat(64), false);
    assert_eq!(first.sequence, 1);
    set(&alice(), COMMITMENT_DEPOSIT, T0 + 2);
    expect_panic("ALREADY_COMMITTED", || {
        c.commit_solution(round.id, "b".repeat(64), false);
    });
    set(&alice(), 0, round.commitment_end.0);
    expect_panic("ROUTE_TOO_LONG", || {
        c.reveal_solution(round.id, "R".repeat(36), salt_for(1));
    });
    expect_panic("SALT_MUST_BE_64_LOWERCASE_HEX", || {
        c.reveal_solution(round.id, "R".to_string(), "A".repeat(64));
    });
}

#[test]
fn participant_cap_is_enforced() {
    let mut c = deploy();
    let round = open(&mut c, &alice(), T0);
    for n in 0..=MAX_PARTICIPANTS {
        let player = id(&format!("crew{n}.testnet"));
        register(&mut c, &player);
        set(&player, COMMITMENT_DEPOSIT, T0 + 1);
        if n < MAX_PARTICIPANTS {
            assert_eq!(c.commit_solution(round.id, "c".repeat(64), false).sequence, n + 1);
        } else {
            expect_panic("ROUND_FULL", || {
                c.commit_solution(round.id, "c".repeat(64), false);
            });
        }
    }
    let page = c.get_commitments(round.id, Some(60), Some(64));
    assert_eq!(page.len(), 5);
    assert_eq!(page[0].sequence, 60);
    assert_eq!(c.get_commitments(round.id, None, Some(1000)).len(), 64);
}

// --------------------------------------------------------------- commitments

#[test]
fn replayed_or_altered_reveals_fail_and_change_nothing() {
    let mut c = deploy();
    for who in [alice(), bob(), carol()] {
        register(&mut c, &who);
    }
    let round = open(&mut c, &alice(), T0);
    let moves = solve(&round.board, false)[0].0.clone();
    let salt = salt_for(7);
    commit(&mut c, &alice(), &round, &moves, &salt, false, T0 + 1);
    // Bob seals a commitment built for Alice's identity; Carol seals one for another contract.
    let alice_hash = commitment_hex(&contract_id(), &alice(), 1, &round.board_hash, false, &moves, &salt);
    set(&bob(), COMMITMENT_DEPOSIT, T0 + 2);
    c.commit_solution(round.id, alice_hash, false);
    let foreign = commitment_hex(&id("other.testnet"), &carol(), 1, &round.board_hash, false, &moves, &salt);
    set(&carol(), COMMITMENT_DEPOSIT, T0 + 3);
    c.commit_solution(round.id, foreign, false);

    let t = reveal_time(&round);
    // Alice reveals honestly; her moves and salt are now public.
    assert!(reveal(&mut c, &alice(), &round, &moves, &salt, t).valid);
    // Copying them from another account fails: the player id is in the preimage.
    for (who, label) in [(bob(), "copied reveal"), (carol(), "cross-contract commitment")] {
        set(&who, 0, t + 1);
        expect_panic("COMMITMENT_MISMATCH", || {
            c.reveal_solution(round.id, moves.clone(), salt.clone());
        });
        assert!(c.get_commitment(round.id, who.clone()).unwrap().reveal.is_none(), "{label} must not change state");
    }
    // An account with no commitment cannot reveal at all.
    set(&id("dave.testnet"), 0, t + 1);
    expect_panic("NO_COMMITMENT_FOR_CALLER", || {
        c.reveal_solution(round.id, moves.clone(), salt.clone());
    });
    set(&alice(), 0, t + 2);
    expect_panic("ALREADY_REVEALED", || {
        c.reveal_solution(round.id, moves.clone(), salt.clone());
    });
    assert_eq!(c.get_round(round.id).unwrap().valid_reveals, 1);
}

#[test]
fn every_preimage_field_is_binding() {
    let mut c = deploy();
    register(&mut c, &alice());
    register(&mut c, &bob());
    let first = open(&mut c, &alice(), T0);
    let moves = solve(&first.board, false)[0].0.clone();
    let salt = salt_for(3);
    // Round 2's board, for the changed-board and cross-round cases.
    let (board2, _, _) = generate_board(&contract_id(), 2);
    let board2_hash = hex(&board_hash(&board2));
    let cases: Vec<(&str, String)> = vec![
        ("different round", commitment_hex(&contract_id(), &alice(), 2, &first.board_hash, false, &moves, &salt)),
        ("different board", commitment_hex(&contract_id(), &alice(), 1, &board2_hash, false, &moves, &salt)),
        ("different contract", commitment_hex(&id("bag-heist-2.testnet"), &alice(), 1, &first.board_hash, false, &moves, &salt)),
        ("different player", commitment_hex(&contract_id(), &bob(), 1, &first.board_hash, false, &moves, &salt)),
        ("different crowbar flag", commitment_hex(&contract_id(), &alice(), 1, &first.board_hash, true, &moves, &salt)),
        ("different route", commitment_hex(&contract_id(), &alice(), 1, &first.board_hash, false, &format!("{moves}U"), &salt)),
        ("different salt", commitment_hex(&contract_id(), &alice(), 1, &first.board_hash, false, &moves, &salt_for(4))),
    ];
    let honest = commitment_hex(&contract_id(), &alice(), 1, &first.board_hash, false, &moves, &salt);
    for (label, hash) in &cases {
        assert_ne!(hash, &honest, "{label} must change the hash");
    }
    // Commit one altered hash and prove the honest reveal cannot open it.
    set(&alice(), COMMITMENT_DEPOSIT, T0 + 1);
    c.commit_solution(first.id, cases[0].1.clone(), false);
    set(&alice(), 0, reveal_time(&first));
    expect_panic("COMMITMENT_MISMATCH", || {
        c.reveal_solution(first.id, moves.clone(), salt.clone());
    });
}

#[test]
fn hash_matching_invalid_reveals_are_recorded_and_burn_the_pot() {
    let mut c = deploy();
    for who in [alice(), bob(), carol()] {
        register(&mut c, &who);
    }
    let round = open(&mut c, &alice(), T0);
    let start = usize::from(round.board.start);
    let outward = if start / SIZE == 0 { "U" } else { "D" };
    commit(&mut c, &alice(), &round, outward, &salt_for(1), false, T0 + 1);
    commit(&mut c, &bob(), &round, "", &salt_for(2), false, T0 + 2);
    commit(&mut c, &carol(), &round, "never revealed", &salt_for(3), false, T0 + 3);
    let t = reveal_time(&round);
    let a = reveal(&mut c, &alice(), &round, outward, &salt_for(1), t);
    assert_eq!((a.valid, a.verdict), (false, Verdict::OutOfBounds));
    let b = reveal(&mut c, &bob(), &round, "", &salt_for(2), t);
    assert_eq!((b.valid, b.verdict), (false, Verdict::NotAtExit));
    let view = c.get_round(round.id).unwrap();
    assert_eq!((view.valid_reveals, view.invalid_reveals), (0, 2));
    let supply = state(&c).total_supply.0;
    let settled = finalize(&mut c, &round, settle_time(&round));
    assert!(settled.burned && settled.winner.is_none());
    assert!(get_logs().iter().any(|l| l.contains("\"ft_burn\"") && l.contains("100000000")));
    let s = state(&c);
    assert_eq!(s.total_supply.0, supply - ROUND_PRIZE);
    assert_eq!(s.cumulative_expired_pots_burned.0, ROUND_PRIZE);
    assert_eq!(s.reserved_prizes.0, 0);
    assert_invariants(&c, &[alice(), bob(), carol()]);
}

// ------------------------------------------------------------------- ranking

#[test]
fn score_ordering_and_every_tie_break() {
    let s = |loot, length, sequence| Score { player_id: alice(), loot, length, sequence };
    assert!(s(20, 18, 3).beats(&s(19, 10, 1)), "more loot wins");
    assert!(s(20, 12, 3).beats(&s(20, 14, 1)), "fewer moves breaks a loot tie");
    assert!(s(20, 12, 1).beats(&s(20, 12, 2)), "earlier sequence breaks a full tie");
    assert!(!s(20, 12, 2).beats(&s(20, 12, 2)), "a score never beats itself");
}

#[test]
fn contract_ranks_real_reveals() {
    let mut c = deploy();
    let crews: Vec<AccountId> = (0..4).map(|n| id(&format!("crew{n}.testnet"))).collect();
    for who in &crews {
        register(&mut c, who);
    }
    let round = open(&mut c, &alice(), T0);
    let routes = solve(&round.board, false);
    // Find two routes with equal loot but different lengths.
    let (long, short) = routes
        .iter()
        .flat_map(|a| routes.iter().map(move |b| (a, b)))
        .find(|(a, b)| a.1 == b.1 && a.2 > b.2)
        .expect("a loot tie with different lengths");
    let lower = routes.iter().find(|r| r.1 < long.1).expect("a lower-loot route");
    // crew0: lower loot; crew1: tie loot, longer; crew2 and crew3: the shorter route.
    let plan = [(&crews[0], &lower.0), (&crews[1], &long.0), (&crews[2], &short.0), (&crews[3], &short.0)];
    for (n, (who, moves)) in plan.iter().enumerate() {
        commit(&mut c, who, &round, moves, &salt_for(n as u8 + 10), false, T0 + 1 + n as u64);
    }
    // Reveal in reverse order so the leader changes as reveals arrive.
    for (n, (who, moves)) in plan.iter().enumerate().rev() {
        reveal(&mut c, who, &round, moves, &salt_for(n as u8 + 10), reveal_time(&round) + n as u64);
    }
    let settled = finalize(&mut c, &round, settle_time(&round));
    assert_eq!(settled.winner, Some(crews[2].clone()), "fewer moves, then earlier sequence");
    assert_eq!(settled.best.unwrap().sequence, 3);
    assert_eq!(c.get_profile(crews[2].clone()).unwrap().wins, 1);
}

// ------------------------------------------------------------------- economy

fn won_round(c: &mut BagHeist, winner: &AccountId, start: u64) -> RoundView {
    let round = open(c, winner, start);
    let moves = solve(&round.board, false)[0].0.clone();
    commit(c, winner, &round, &moves, &salt_for(9), false, start + 1);
    reveal(c, winner, &round, &moves, &salt_for(9), reveal_time(&round));
    finalize(c, &round, settle_time(&round))
}

#[test]
fn winner_claims_exactly_one_prize_once() {
    let mut c = deploy();
    register(&mut c, &alice());
    register(&mut c, &bob());
    ft_register(&mut c, &alice());
    let round = won_round(&mut c, &alice(), T0);
    let t = settle_time(&round) + 1;
    let supply = state(&c).total_supply.0;
    set(&alice(), 0, t);
    expect_panic("yoctoNEAR", || {
        c.claim_reward(round.id);
    });
    set(&bob(), ONE_YOCTO, t);
    expect_panic("NOT_THE_WINNER", || {
        c.claim_reward(round.id);
    });
    assert_eq!(claim(&mut c, &alice(), &round, t).0, ROUND_PRIZE);
    assert_eq!(c.ft_balance_of(alice()).0, ROUND_PRIZE);
    assert!(get_logs().iter().any(|l| l.contains("\"ft_transfer\"")));
    set(&alice(), ONE_YOCTO, t + 1);
    expect_panic("ALREADY_CLAIMED", || {
        c.claim_reward(round.id);
    });
    let s = state(&c);
    assert_eq!(s.total_supply.0, supply, "claims move tokens, they never mint");
    assert_eq!((s.reserved_prizes.0, s.cumulative_rewards_paid.0), (0, ROUND_PRIZE));
    assert_eq!(c.get_profile(alice()).unwrap().bag_won.0, ROUND_PRIZE);
    assert_invariants(&c, &[alice(), bob()]);
}

#[test]
fn claim_before_finalization_fails() {
    let mut c = deploy();
    register(&mut c, &alice());
    let round = open(&mut c, &alice(), T0);
    set(&alice(), ONE_YOCTO, T0 + 1);
    expect_panic("ROUND_NOT_FINALIZED", || {
        c.claim_reward(round.id);
    });
}

#[test]
fn winner_can_reregister_token_storage_and_still_claim() {
    let mut c = deploy();
    register(&mut c, &alice());
    ft_register(&mut c, &alice());
    let round = won_round(&mut c, &alice(), T0);
    let t = settle_time(&round) + 1;
    set(&alice(), ONE_YOCTO, t);
    assert!(c.storage_unregister(None));
    set(&alice(), ONE_YOCTO, t + 1);
    expect_panic("REGISTER_BAG_STORAGE_FIRST", || {
        c.claim_reward(round.id);
    });
    assert_eq!(state(&c).reserved_prizes.0, ROUND_PRIZE, "prize stays reserved while unregistered");
    ft_register(&mut c, &alice());
    claim(&mut c, &alice(), &round, t + 2);
    assert_eq!(c.ft_balance_of(alice()).0, ROUND_PRIZE);
    assert_invariants(&c, &[alice()]);
}

#[test]
fn crafting_burns_exactly_five_bag_and_respects_the_cap() {
    let mut c = deploy();
    register(&mut c, &alice());
    register(&mut c, &bob());
    ft_register(&mut c, &alice());
    let round = won_round(&mut c, &alice(), T0);
    let t = settle_time(&round) + 1;
    claim(&mut c, &alice(), &round, t);
    let before = state(&c);
    set(&alice(), ONE_YOCTO, t);
    let profile = c.craft_crowbar();
    assert_eq!((profile.crowbars, profile.crafted), (1, 1));
    assert!(get_logs().iter().any(|l| l.contains("\"ft_burn\"") && l.contains("5000000")));
    let after = state(&c);
    assert_eq!(after.total_supply.0, before.total_supply.0 - CROWBAR_PRICE);
    assert_eq!(after.cumulative_crafting_burned.0, CROWBAR_PRICE);
    assert_eq!(after.unallocated_game_budget.0, before.unallocated_game_budget.0, "crafting never touches the prize budget");
    assert_eq!(after.reserved_prizes.0, before.reserved_prizes.0);
    for _ in 1..MAX_CROWBARS {
        set(&alice(), ONE_YOCTO, t);
        c.craft_crowbar();
    }
    set(&alice(), ONE_YOCTO, t);
    expect_panic("CROWBAR_INVENTORY_FULL", || {
        c.craft_crowbar();
    });
    assert_eq!(c.ft_balance_of(alice()).0, ROUND_PRIZE - 10 * CROWBAR_PRICE);
    set(&bob(), ONE_YOCTO, t);
    expect_panic("NOT_ENOUGH_BAG", || {
        c.craft_crowbar();
    });
    set(&carol(), ONE_YOCTO, t);
    expect_panic("PROFILE_NOT_REGISTERED", || {
        c.craft_crowbar();
    });
    assert_invariants(&c, &[alice(), bob()]);
}

#[test]
fn crowbars_are_consumed_on_commit_and_open_one_door() {
    let mut c = deploy();
    register(&mut c, &alice());
    register(&mut c, &bob());
    ft_register(&mut c, &alice());
    let first = won_round(&mut c, &alice(), T0);
    let t = settle_time(&first) + 1;
    claim(&mut c, &alice(), &first, t);
    for _ in 0..2 {
        set(&alice(), ONE_YOCTO, t);
        c.craft_crowbar();
    }
    // Round 2: Alice spends a crowbar on a door route; Bob plays it straight.
    let second = open(&mut c, &bob(), t + 1);
    let door = solve(&second.board, true).into_iter().find(|(m, _, _)| check_route(&second.board, m, true).doors == 1).unwrap();
    let plain = solve(&second.board, false)[0].clone();
    assert!(door.1 > plain.1);
    let sealed = commit(&mut c, &alice(), &second, &door.0, &salt_for(5), true, t + 2);
    assert_eq!(sealed.crowbar_serial, Some(1));
    assert!(get_logs().iter().any(|l| l.contains("crowbar_consumed")));
    commit(&mut c, &bob(), &second, &plain.0, &salt_for(6), false, t + 3);
    let profile = c.get_profile(alice()).unwrap();
    assert_eq!((profile.crowbars, profile.consumed), (1, 1));
    let used = c.get_crowbar(alice(), 1).unwrap();
    assert_eq!((used.status, used.consumed_in_round), (CrowbarStatus::Consumed, Some(U64(2))));
    assert_eq!(c.get_crowbar(alice(), 2).unwrap().status, CrowbarStatus::Ready);
    assert!(c.get_crowbar(alice(), 3).is_none());
    assert_eq!(c.get_crowbars(alice(), None, None).len(), 2);
    let opened = reveal(&mut c, &alice(), &second, &door.0, &salt_for(5), reveal_time(&second));
    assert!(opened.valid && opened.doors == 1);
    reveal(&mut c, &bob(), &second, &plain.0, &salt_for(6), reveal_time(&second));
    assert_eq!(finalize(&mut c, &second, settle_time(&second)).winner, Some(alice()));

    // Round 3: a crowbar committed and never revealed is still spent.
    let third = open(&mut c, &bob(), settle_time(&second) + 1);
    commit(&mut c, &alice(), &third, "RRRR", &salt_for(8), true, settle_time(&second) + 2);
    assert_eq!(c.get_profile(alice()).unwrap().crowbars, 0);
    let burned = finalize(&mut c, &third, settle_time(&third));
    assert!(burned.burned);
    assert_eq!(c.get_crowbar(alice(), 2).unwrap().consumed_in_round, Some(U64(3)));
}

#[test]
fn treasury_cannot_be_drained_or_unregistered_by_a_key_holder() {
    let mut c = deploy();
    register(&mut c, &alice());
    ft_register(&mut c, &alice());
    ft_register(&mut c, &bob());
    let round = won_round(&mut c, &alice(), T0);
    let t = settle_time(&round) + 1;
    claim(&mut c, &alice(), &round, t);
    // A donation raises the treasury balance but never the game budget.
    set(&alice(), ONE_YOCTO, t);
    c.ft_transfer(contract_id(), U128(10_000_000), None);
    let s = state(&c);
    assert_eq!(s.treasury_balance.0, s.unallocated_game_budget.0 + s.reserved_prizes.0 + 10_000_000);
    // The contract account may move only the uncommitted excess.
    set(&contract_id(), ONE_YOCTO, t);
    expect_panic("TREASURY_MUST_COVER_GAME_BUDGET", || {
        c.ft_transfer(bob(), U128(10_000_001), None);
    });
    set(&contract_id(), ONE_YOCTO, t);
    c.ft_transfer(bob(), U128(10_000_000), None);
    set(&contract_id(), ONE_YOCTO, t);
    expect_panic("TREASURY_CANNOT_UNREGISTER", || {
        c.storage_unregister(Some(true));
    });
    assert_invariants(&c, &[alice(), bob()]);
}

#[test]
fn forced_unregistration_burns_are_audited() {
    let mut c = deploy();
    register(&mut c, &alice());
    ft_register(&mut c, &alice());
    ft_register(&mut c, &bob());
    let round = won_round(&mut c, &alice(), T0);
    let t = settle_time(&round) + 1;
    claim(&mut c, &alice(), &round, t);
    set(&alice(), ONE_YOCTO, t);
    c.ft_transfer(bob(), U128(10_000_000), None);
    set(&alice(), ONE_YOCTO, t);
    expect_panic("without force", || {
        c.storage_unregister(None);
    });
    let supply = state(&c).total_supply.0;
    set(&alice(), ONE_YOCTO, t);
    assert!(c.storage_unregister(Some(true)));
    assert!(get_logs().iter().any(|l| l.contains("\"ft_burn\"") && l.contains("90000000")));
    let s = state(&c);
    assert_eq!(s.total_supply.0, supply - 90_000_000);
    assert_eq!(s.cumulative_storage_burned.0, 90_000_000);
    assert_invariants(&c, &[alice(), bob()]);
}

#[test]
fn pending_transfer_call_never_funds_a_prize() {
    let mut c = deploy();
    register(&mut c, &alice());
    ft_register(&mut c, &alice());
    ft_register(&mut c, &bob());
    let first = won_round(&mut c, &alice(), T0);
    let t = settle_time(&first) + 1;
    claim(&mut c, &alice(), &first, t);
    let budget = state(&c).unallocated_game_budget.0;

    // Alice sends 40 BAG to the game contract with ft_transfer_call. The
    // contract has no ft_on_transfer, so the receiver call will fail and the
    // resolver will refund; until then the treasury holds 40 extra BAG.
    set(&alice(), ONE_YOCTO, t);
    let _ = c.ft_transfer_call(contract_id(), U128(40_000_000), None, "fund".into());
    // While that transfer is unresolved, a round opens and settles with a burn.
    let pending_round = open(&mut c, &bob(), t + 1);
    assert_eq!(state(&c).unallocated_game_budget.0, budget - ROUND_PRIZE, "pending tokens add no budget");
    finalize(&mut c, &pending_round, settle_time(&pending_round));
    // Resolution arrives: the receiver call failed, everything is refunded.
    set_with(&contract_id(), 0, settle_time(&pending_round) + 1, vec![PromiseResult::Failed]);
    let used = c.ft_resolve_transfer(alice(), contract_id(), U128(40_000_000));
    assert_eq!(used.0, 0);
    assert_eq!(c.ft_balance_of(alice()).0, ROUND_PRIZE);
    assert_invariants(&c, &[alice(), bob()]);

    // Sender unregisters while a transfer to Bob is in flight: the refund
    // cannot be returned, the standard resolver burns it, and the audit records it.
    set(&alice(), ONE_YOCTO, t + 2);
    let _ = c.ft_transfer_call(bob(), U128(30_000_000), None, "gift".into());
    set(&alice(), ONE_YOCTO, t + 3);
    assert!(c.storage_unregister(Some(true)));
    set_with(&contract_id(), 0, t + 4, vec![PromiseResult::Successful(b"\"30000000\"".to_vec())]);
    let used = c.ft_resolve_transfer(alice(), bob(), U128(30_000_000));
    assert_eq!(used.0, 30_000_000, "burned refund counts as used");
    let s = state(&c);
    assert_eq!(s.cumulative_resolver_burned.0, 30_000_000);
    assert_eq!(s.cumulative_storage_burned.0, 70_000_000);
    assert_eq!(c.ft_balance_of(bob()).0, 0);
    assert_invariants(&c, &[alice(), bob()]);
}

#[test]
fn whole_treasury_drains_by_exactly_ten_thousand_rounds() {
    let mut c = deploy();
    let mut now = T0;
    for _ in 0..(INITIAL_SUPPLY / ROUND_PRIZE) {
        let round = open(&mut c, &alice(), now);
        now = round.reveal_end.0;
        finalize(&mut c, &round, now);
    }
    let s = state(&c);
    assert_eq!(s.round_count.0, 10_000);
    assert_eq!(s.total_supply.0, 0);
    assert_eq!(s.unallocated_game_budget.0, 0);
    assert_eq!(s.cumulative_expired_pots_burned.0, INITIAL_SUPPLY);
    assert!(s.budget_identity_holds && s.supply_audit_holds);
    set(&alice(), ROUND_DEPOSIT, now + 1);
    expect_panic("GAME_BUDGET_EXHAUSTED", || {
        c.open_round();
    });
}

#[test]
fn storage_deposits_cover_worst_case() {
    let mut c = deploy();
    let long = |p: &str| id(&format!("{}.testnet", p.repeat(56)));
    let (a, b) = (long("a"), long("b"));
    let byte = env::storage_byte_cost().as_yoctonear();
    // Each `set` installs a fresh mocked chain, so measure within one context.
    let measure = |c: &mut BagHeist, who: &AccountId, deposit: u128, now: u64, f: &mut dyn FnMut(&mut BagHeist)| {
        set(who, deposit, now);
        c.flush();
        let before = env::storage_usage();
        f(c);
        c.flush();
        env::storage_usage() - before
    };
    let profile = measure(&mut c, &a, PROFILE_DEPOSIT, T0, &mut |c| {
        c.register_profile();
    });
    register(&mut c, &b);
    ft_register(&mut c, &a);
    let first = won_round(&mut c, &a, T0);
    claim(&mut c, &a, &first, settle_time(&first) + 1);
    set(&a, ONE_YOCTO, settle_time(&first) + 1);
    c.craft_crowbar();
    let start = settle_time(&first) + 2;
    let mut round = None;
    let open_bytes = measure(&mut c, &b, ROUND_DEPOSIT, start, &mut |c| round = Some(c.open_round()));
    let round = round.unwrap();
    let route = solve(&round.board, true).into_iter().filter(|(m, _, _)| check_route(&round.board, m, true).doors == 1).max_by_key(|r| r.0.len()).unwrap().0;
    let hash = commitment_hex(&contract_id(), &a, round.id.0, &round.board_hash, true, &route, &salt_for(1));
    let commit_bytes = measure(&mut c, &a, COMMITMENT_DEPOSIT, start + 1, &mut |c| {
        c.commit_solution(round.id, hash.clone(), true);
    });
    let reveal_bytes = measure(&mut c, &a, 0, reveal_time(&round), &mut |c| {
        c.reveal_solution(round.id, route.clone(), salt_for(1));
    });
    let finalize_bytes = measure(&mut c, &carol(), 0, settle_time(&round), &mut |c| {
        c.finalize_round(round.id);
    });
    let round_total = open_bytes + finalize_bytes + 76; // + best-score growth recorded during the reveal
    let commitment_total = commit_bytes + reveal_bytes;
    println!("measured worst-case storage (64-char accounts):");
    println!("  profile     {profile:>4} bytes = {} yocto; deposit {PROFILE_DEPOSIT}", u128::from(profile) * byte);
    println!("  round       {round_total:>4} bytes = {} yocto; deposit {ROUND_DEPOSIT}", u128::from(round_total) * byte);
    println!("  commitment  {commitment_total:>4} bytes = {} yocto; deposit {COMMITMENT_DEPOSIT}", u128::from(commitment_total) * byte);
    assert!(reveal_bytes - 76 <= REVEAL_GROWTH_RESERVE + 8, "reveal reserve: {reveal_bytes}");
    assert!(finalize_bytes <= ROUND_GROWTH_RESERVE, "finalize growth: {finalize_bytes}");
    for (bytes, deposit) in [(profile, PROFILE_DEPOSIT), (round_total, ROUND_DEPOSIT), (commitment_total, COMMITMENT_DEPOSIT)] {
        assert!(u128::from(bytes) * byte * 3 <= deposit, "deposit {deposit} must be at least 3x the measured {bytes} bytes");
    }
}

// --------------------------------------------- randomized model-based sequences

/// A deliberately simple, independent model of the economy and round rules.
/// It recomputes the winner by sorting every valid reveal at finalization
/// instead of tracking a running best, and checks routes with its own walker.
#[derive(Clone, Default)]
struct Model {
    now: u64,
    supply: u128,
    balances: BTreeMap<AccountId, u128>,
    unallocated: u128,
    reserved: u128,
    paid: u128,
    expired: u128,
    crafted: u128,
    storage_burned: u128,
    crowbars: BTreeMap<AccountId, u8>,
    rounds: Vec<ModelRound>,
}

#[derive(Clone)]
struct ModelRound {
    board: Board,
    commitment_end: u64,
    reveal_end: u64,
    finalized: bool,
    winner: Option<AccountId>,
    claimed: bool,
    burned: bool,
    commits: Vec<ModelCommit>,
}

#[derive(Clone)]
struct ModelCommit {
    player: AccountId,
    crowbar: bool,
    moves: String,
    salt: String,
    revealed: Option<(bool, u16, u16)>,
}

fn model_route(board: &Board, moves: &str, crowbar: bool) -> (bool, u16, u16) {
    let (mut r, mut c) = ((board.start / 6) as i32, (board.start % 6) as i32);
    let mut visited = [false; 36];
    visited[usize::from(board.start)] = true;
    let mut loot = u16::from(board.loot[usize::from(board.start)]);
    let mut doors = 0;
    let len = moves.len() as u16;
    if moves.len() > 35 {
        return (false, loot, len);
    }
    for m in moves.chars() {
        if r * 6 + c == i32::from(board.exit) {
            return (false, loot, len);
        }
        match m {
            'U' => r -= 1,
            'D' => r += 1,
            'L' => c -= 1,
            'R' => c += 1,
            _ => return (false, loot, len),
        }
        if !(0..6).contains(&r) || !(0..6).contains(&c) {
            return (false, loot, len);
        }
        let i = (r * 6 + c) as usize;
        if board.tiles[i] == 1 || visited[i] {
            return (false, loot, len);
        }
        if board.tiles[i] == 2 {
            doors += 1;
            if !crowbar || doors > 1 {
                return (false, loot, len);
            }
        }
        visited[i] = true;
        loot += u16::from(board.loot[i]);
    }
    (r * 6 + c == i32::from(board.exit), loot, len)
}

#[derive(Debug)]
#[allow(dead_code)] // player indexes are read through Debug in failure labels
enum Action {
    Register(usize),
    FtRegister(usize),
    Open(usize),
    Commit(usize, u8, bool),
    Reveal(usize, bool),
    Advance(u8),
    Finalize,
    Claim(usize, usize),
    Craft(usize),
    Transfer(usize, usize, u128),
    Unregister(usize, bool),
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn snapshot(c: &mut BagHeist) -> (Vec<u8>, HashMap<Vec<u8>, Vec<u8>>) {
    c.flush();
    let bytes = near_sdk::borsh::to_vec(c).unwrap();
    let storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
    let copy = storage.clone();
    install(storage);
    (bytes, copy)
}

fn install(storage: HashMap<Vec<u8>, Vec<u8>>) {
    let context = CONTEXT.with(|c| c.borrow().clone().unwrap());
    env::set_blockchain_interface(MockedBlockchain::new(
        context,
        test_vm_config(),
        RuntimeFeesConfig::test(),
        vec![],
        storage,
        Default::default(),
        None,
    ));
}

fn run_model_sequence(seed: u64, steps: usize) {
    let players: Vec<AccountId> = ["ana", "ben", "cyd", "dov"].iter().map(|n| id(&format!("{n}.testnet"))).collect();
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut c = deploy();
    let mut m = Model { now: T0, supply: INITIAL_SUPPLY, unallocated: INITIAL_SUPPLY, ..Default::default() };
    m.balances.insert(contract_id(), INITIAL_SUPPLY);

    for step in 0..steps {
        let p = rng.below(4) as usize;
        let q = rng.below(4) as usize;
        let action = match rng.below(100) {
            0..=6 => Action::Register(p),
            7..=12 => Action::FtRegister(p),
            13..=22 => Action::Open(p),
            23..=40 => Action::Commit(p, rng.below(4) as u8, rng.below(4) == 0),
            41..=55 => Action::Reveal(p, rng.below(6) == 0),
            56..=70 => Action::Advance(rng.below(6) as u8),
            71..=78 => Action::Finalize,
            79..=86 => Action::Claim(p, rng.below(3) as usize),
            87..=92 => Action::Craft(p),
            93..=97 => Action::Transfer(p, q, u128::from(rng.below(4)) * 2_500_000),
            _ => Action::Unregister(p, rng.below(2) == 0),
        };
        let who = players[p].clone();
        let current = m.rounds.len();
        // expected: Ok(()) or Err(Some(code)) or Err(None) for "any standard FT error"
        let mut expected: Result<(), Option<&str>> = Ok(());
        let mut next = m.clone();
        let label = format!("seed {seed} step {step} {action:?}");
        let (snap_state, snap_storage) = snapshot(&mut c);
        let outcome = guarded(|| match &action {
            Action::Register(_) => {
                if m.crowbars.contains_key(&who) {
                    expected = Err(Some("PROFILE_EXISTS"));
                } else {
                    next.crowbars.insert(who.clone(), 0);
                }
                set(&who, PROFILE_DEPOSIT, m.now);
                c.register_profile();
            }
            Action::FtRegister(_) => {
                next.balances.entry(who.clone()).or_insert(0);
                set(&who, FT_STORAGE, m.now);
                c.storage_deposit(None, None);
            }
            Action::Open(_) => {
                if m.rounds.last().is_some_and(|r| !r.finalized) {
                    expected = Err(Some("PREVIOUS_ROUND_NOT_FINALIZED"));
                } else if m.unallocated < ROUND_PRIZE {
                    expected = Err(Some("GAME_BUDGET_EXHAUSTED"));
                } else {
                    let (board, _, _) = generate_board(&contract_id(), current as u64 + 1);
                    next.unallocated -= ROUND_PRIZE;
                    next.reserved += ROUND_PRIZE;
                    next.rounds.push(ModelRound {
                        board,
                        commitment_end: m.now + COMMITMENT_WINDOW_NS,
                        reveal_end: m.now + COMMITMENT_WINDOW_NS + REVEAL_WINDOW_NS,
                        finalized: false,
                        winner: None,
                        claimed: false,
                        burned: false,
                        commits: vec![],
                    });
                }
                set(&who, ROUND_DEPOSIT, m.now);
                c.open_round();
            }
            Action::Commit(_, quality, crowbar) => {
                let Some(round) = m.rounds.last() else { return };
                let routes = solve(&round.board, *crowbar);
                let moves = match quality {
                    0 => routes[0].0.clone(),
                    1 => routes[routes.len() / 2].0.clone(),
                    2 => routes[routes.len() - 1].0.clone(),
                    _ => "RRDDLL".to_string(),
                };
                let salt = salt_for((step % 251) as u8);
                if round.finalized || m.now >= round.commitment_end {
                    expected = Err(Some("COMMITMENT_WINDOW_CLOSED"));
                } else if !m.crowbars.contains_key(&who) {
                    expected = Err(Some("PROFILE_NOT_REGISTERED"));
                } else if round.commits.iter().any(|x| x.player == who) {
                    expected = Err(Some("ALREADY_COMMITTED"));
                } else if *crowbar && m.crowbars[&who] == 0 {
                    expected = Err(Some("NO_CROWBAR_IN_INVENTORY"));
                } else {
                    if *crowbar {
                        *next.crowbars.get_mut(&who).unwrap() -= 1;
                    }
                    next.rounds.last_mut().unwrap().commits.push(ModelCommit {
                        player: who.clone(),
                        crowbar: *crowbar,
                        moves: moves.clone(),
                        salt: salt.clone(),
                        revealed: None,
                    });
                }
                let hash = commitment_hex(&contract_id(), &who, current as u64, &hex(&board_hash(&round.board)), *crowbar, &moves, &salt);
                set(&who, COMMITMENT_DEPOSIT, m.now);
                c.commit_solution(U64(current as u64), hash, *crowbar);
            }
            Action::Reveal(_, forged) => {
                let Some(round) = m.rounds.last() else { return };
                let mine = round.commits.iter().position(|x| x.player == who);
                let (moves, mut salt) = mine.map_or(("R".to_string(), salt_for(0)), |i| (round.commits[i].moves.clone(), round.commits[i].salt.clone()));
                if *forged {
                    salt = salt_for(252);
                }
                if m.now < round.commitment_end {
                    expected = Err(Some("REVEAL_WINDOW_NOT_OPEN"));
                } else if m.now >= round.reveal_end || round.finalized {
                    expected = Err(Some("REVEAL_WINDOW_CLOSED"));
                } else if let Some(i) = mine {
                    if round.commits[i].revealed.is_some() {
                        expected = Err(Some("ALREADY_REVEALED"));
                    } else if *forged {
                        expected = Err(Some("COMMITMENT_MISMATCH"));
                    } else {
                        let result = model_route(&round.board, &moves, round.commits[i].crowbar);
                        next.rounds.last_mut().unwrap().commits[i].revealed = Some(result);
                    }
                } else {
                    expected = Err(Some("NO_COMMITMENT_FOR_CALLER"));
                }
                set(&who, 0, m.now);
                c.reveal_solution(U64(current as u64), moves, salt);
            }
            Action::Advance(kind) => {
                let t = m.rounds.last().map_or(m.now, |r| match kind {
                    0 => r.commitment_end - 1,
                    1 => r.commitment_end,
                    2 => r.reveal_end - 1,
                    3 => r.reveal_end,
                    _ => m.now,
                });
                next.now = m.now.max(t) + if *kind >= 4 { 7_000_000_000 } else { 0 };
            }
            Action::Finalize => {
                let Some(round) = m.rounds.last() else { return };
                if round.finalized {
                    expected = Err(Some("ALREADY_FINALIZED"));
                } else if m.now < round.reveal_end {
                    expected = Err(Some("REVEAL_WINDOW_STILL_OPEN"));
                } else {
                    let r = next.rounds.last_mut().unwrap();
                    r.finalized = true;
                    let mut valid: Vec<(u16, u16, usize)> = r
                        .commits
                        .iter()
                        .enumerate()
                        .filter_map(|(i, x)| x.revealed.filter(|v| v.0).map(|v| (v.1, v.2, i)))
                        .collect();
                    valid.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
                    if let Some(best) = valid.first() {
                        r.winner = Some(r.commits[best.2].player.clone());
                    } else {
                        r.burned = true;
                        next.reserved -= ROUND_PRIZE;
                        next.expired += ROUND_PRIZE;
                        next.supply -= ROUND_PRIZE;
                        *next.balances.get_mut(&contract_id()).unwrap() -= ROUND_PRIZE;
                    }
                }
                set(&carol(), 0, m.now);
                c.finalize_round(U64(current as u64));
            }
            Action::Claim(_, back) => {
                if m.rounds.is_empty() {
                    return;
                }
                let index = m.rounds.len().saturating_sub(1 + back).min(m.rounds.len() - 1);
                let round = &m.rounds[index];
                if !round.finalized {
                    expected = Err(Some("ROUND_NOT_FINALIZED"));
                } else if round.winner.as_ref() != Some(&who) {
                    expected = Err(Some("NOT_THE_WINNER"));
                } else if round.claimed {
                    expected = Err(Some("ALREADY_CLAIMED"));
                } else if !m.balances.contains_key(&who) {
                    expected = Err(Some("REGISTER_BAG_STORAGE_FIRST"));
                } else {
                    next.rounds[index].claimed = true;
                    next.reserved -= ROUND_PRIZE;
                    next.paid += ROUND_PRIZE;
                    *next.balances.get_mut(&contract_id()).unwrap() -= ROUND_PRIZE;
                    *next.balances.get_mut(&who).unwrap() += ROUND_PRIZE;
                }
                set(&who, ONE_YOCTO, m.now);
                c.claim_reward(U64(index as u64 + 1));
            }
            Action::Craft(_) => {
                if !m.crowbars.contains_key(&who) {
                    expected = Err(Some("PROFILE_NOT_REGISTERED"));
                } else if m.crowbars[&who] >= MAX_CROWBARS {
                    expected = Err(Some("CROWBAR_INVENTORY_FULL"));
                } else if m.balances.get(&who).copied().unwrap_or(0) < CROWBAR_PRICE {
                    expected = Err(Some("NOT_ENOUGH_BAG"));
                } else {
                    *next.crowbars.get_mut(&who).unwrap() += 1;
                    *next.balances.get_mut(&who).unwrap() -= CROWBAR_PRICE;
                    next.supply -= CROWBAR_PRICE;
                    next.crafted += CROWBAR_PRICE;
                }
                set(&who, ONE_YOCTO, m.now);
                c.craft_crowbar();
            }
            Action::Transfer(_, to, amount) => {
                let target = players[*to].clone();
                let from_balance = m.balances.get(&who).copied();
                if who == target || *amount == 0 || from_balance.is_none() || !m.balances.contains_key(&target) || from_balance.unwrap() < *amount {
                    expected = Err(None);
                } else {
                    *next.balances.get_mut(&who).unwrap() -= amount;
                    *next.balances.get_mut(&target).unwrap() += amount;
                }
                set(&who, ONE_YOCTO, m.now);
                c.ft_transfer(target, U128(*amount), None);
            }
            Action::Unregister(_, force) => {
                if let Some(balance) = m.balances.get(&who).copied() {
                    if balance > 0 && !force {
                        expected = Err(None);
                    } else {
                        next.balances.remove(&who);
                        next.supply -= balance;
                        next.storage_burned += balance;
                    }
                }
                set(&who, ONE_YOCTO, m.now);
                c.storage_unregister(Some(*force));
            }
        });
        match (&outcome, &expected) {
            (Ok(()), Ok(())) => m = next,
            (Err(payload), Err(code)) => {
                let text = panic_text(payload.as_ref());
                if let Some(code) = code {
                    assert!(text.contains(code), "{label}: expected {code}, got {text}");
                }
                c = near_sdk::borsh::from_slice(&snap_state).unwrap();
                install(snap_storage);
            }
            (Ok(()), Err(code)) => panic!("{label}: contract accepted, model expected {code:?}"),
            (Err(payload), Ok(())) => panic!("{label}: contract rejected with {}", panic_text(payload.as_ref())),
        }
        // Compare the full observable economy after every step.
        set(&carol(), 0, m.now);
        let s = state(&c);
        assert_eq!(s.total_supply.0, m.supply, "{label}: supply");
        assert_eq!(s.unallocated_game_budget.0, m.unallocated, "{label}: unallocated");
        assert_eq!(s.reserved_prizes.0, m.reserved, "{label}: reserved");
        assert_eq!(s.cumulative_rewards_paid.0, m.paid, "{label}: paid");
        assert_eq!(s.cumulative_expired_pots_burned.0, m.expired, "{label}: expired");
        assert_eq!(s.cumulative_crafting_burned.0, m.crafted, "{label}: crafted");
        assert_eq!(s.cumulative_storage_burned.0, m.storage_burned, "{label}: storage burned");
        assert!(s.budget_identity_holds && s.treasury_covers_budget && s.supply_audit_holds, "{label}: invariants");
        let mut sum = 0;
        for account in players.iter().chain([contract_id()].iter()) {
            let balance = c.ft_balance_of(account.clone()).0;
            assert_eq!(balance, m.balances.get(account).copied().unwrap_or(0), "{label}: balance of {account}");
            sum += balance;
        }
        assert_eq!(sum, s.total_supply.0, "{label}: sum of balances");
        for player in &players {
            assert_eq!(c.get_profile(player.clone()).map(|p| p.crowbars), m.crowbars.get(player).copied(), "{label}: crowbars of {player}");
        }
        for (i, r) in m.rounds.iter().enumerate() {
            let view = c.get_round(U64(i as u64 + 1)).unwrap();
            assert_eq!((view.finalized, view.winner.clone(), view.claimed, view.burned), (r.finalized, r.winner.clone(), r.claimed, r.burned), "{label}: round {}", i + 1);
        }
    }
}

/// Seeds are fixed so any failure reproduces exactly; the failing seed and
/// step are printed in the assertion message.
#[test]
fn randomized_sequences_match_reference_model() {
    for seed in 1..=24u64 {
        run_model_sequence(seed, 160);
    }
}
