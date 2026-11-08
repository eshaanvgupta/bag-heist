//! Pure board logic: templates, deterministic generation, canonical hashing,
//! commitment preimages and the route checker. Nothing here touches contract
//! state, so the TypeScript port in `src/engine/rules.ts` can mirror it exactly
//! and both are checked against the shared fixtures in `fixtures/`.

use near_sdk::{env, near, AccountId};

pub const SIZE: usize = 6;
pub const CELLS: usize = 36;
pub const MAX_MOVES: usize = 35;
pub const NETWORK: &str = "near:testnet";

pub const TILE_OPEN: u8 = 0;
pub const TILE_WALL: u8 = 1;
pub const TILE_DOOR: u8 = 2;

/// Eight hand-curated vaults. `S` start, `E` exit, `#` wall, `D` locked door,
/// `.` empty floor, `1`-`9` loot. Every template has at least one route that
/// needs no crowbar, and its best single-door route beats its best plain route.
/// `fixtures/templates.json` must match this table (checked by a unit test).
pub const TEMPLATES: [[&str; 6]; 8] = [
    ["S1#.2.", "#513##", "5.835.", "61D4##", "...6#.", "#6D33E"],
    ["S2#25#", "#2#2.#", "1629.8", "3##32#", "D.D9.3", "#8..8E"],
    ["S8#73.", ".81.2.", "#1.4D#", "2.#.##", "D8.28.", ".1##7E"],
    ["S.4..5", "4#151.", "6#.##9", "#762D1", "#23D.1", "##..1E"],
    ["S##23#", "2129#8", "D4#432", "83.2D5", "D221##", "1#8.5E"],
    ["SD.##1", "3.3266", "1.2###", "592#4D", "9D5#31", ".#295E"],
    ["S.27.#", "#3.D#4", ".3#5#D", "#149.5", "##.61D", "2.2..E"],
    ["S3##7#", "72.#13", ".D1#7#", "#.355.", "D15712", "983#.E"],
];

pub const TEMPLATE_NAMES: [&str; 8] = [
    "Lobby",
    "Counting House",
    "Night Desk",
    "Cold Storage",
    "Deposit Row",
    "Server Hall",
    "Gallery",
    "Loading Dock",
];

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Board {
    pub start: u8,
    pub exit: u8,
    /// Row-major tile tags: 0 open, 1 wall, 2 door.
    pub tiles: Vec<u8>,
    /// Row-major loot values 0-9.
    pub loot: Vec<u8>,
}

/// Why a route was accepted or rejected. Serialized as SCREAMING_SNAKE_CASE.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verdict {
    Ok,
    TooLong,
    BadMove,
    PastExit,
    OutOfBounds,
    Wall,
    Revisit,
    DoorLocked,
    SecondDoor,
    NotAtExit,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteCheck {
    pub valid: bool,
    pub verdict: Verdict,
    pub loot: u16,
    /// UTF-8 byte length of the submitted route.
    pub length: u16,
    pub doors: u8,
    /// Tiles visited, starting with the start tile.
    pub path: Vec<u8>,
}

pub fn template(index: usize) -> Board {
    let rows = &TEMPLATES[index];
    let mut board = Board { start: 0, exit: 0, tiles: vec![TILE_OPEN; CELLS], loot: vec![0; CELLS] };
    for (row, line) in rows.iter().enumerate() {
        assert!(line.len() == SIZE, "TEMPLATE_WIDTH");
        for (column, cell) in line.bytes().enumerate() {
            let tile = row * SIZE + column;
            match cell {
                b'S' => board.start = tile as u8,
                b'E' => board.exit = tile as u8,
                b'#' => board.tiles[tile] = TILE_WALL,
                b'D' => board.tiles[tile] = TILE_DOOR,
                b'.' => {}
                b'1'..=b'9' => board.loot[tile] = cell - b'0',
                _ => panic!("TEMPLATE_TILE"),
            }
        }
    }
    board
}

/// Dihedral transform: reflect columns when `transform >= 4`, then rotate
/// clockwise `transform % 4` times. Start, exit, tiles and loot move together.
pub fn transform(board: &Board, transform: u8) -> Board {
    assert!(transform < 8, "TRANSFORM");
    let mut output = Board { start: 0, exit: 0, tiles: vec![TILE_OPEN; CELLS], loot: vec![0; CELLS] };
    for old in 0..CELLS {
        let (mut row, mut column) = (old / SIZE, old % SIZE);
        if transform >= 4 {
            column = SIZE - 1 - column;
        }
        for _ in 0..transform % 4 {
            (row, column) = (column, SIZE - 1 - row);
        }
        let new = row * SIZE + column;
        output.tiles[new] = board.tiles[old];
        output.loot[new] = board.loot[old];
        if old == usize::from(board.start) {
            output.start = new as u8;
        }
        if old == usize::from(board.exit) {
            output.exit = new as u8;
        }
    }
    output
}

pub fn lp16(output: &mut Vec<u8>, value: &str) {
    let length = u16::try_from(value.len()).expect("LP16_OVERFLOW");
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(value.as_bytes());
}

/// SHA-256("BAG_HEIST_GENERATE_V1\0" || LP16(contract) || u64_le(round)).
pub fn generation_seed(contract: &AccountId, round: u64) -> [u8; 32] {
    let mut preimage = b"BAG_HEIST_GENERATE_V1\0".to_vec();
    lp16(&mut preimage, contract.as_str());
    preimage.extend_from_slice(&round.to_le_bytes());
    env::sha256_array(&preimage)
}

/// Returns (board, template index, transform). Template = seed[0] % 8 and
/// transform = seed[1] % 8; 256 is a multiple of 8, so neither is biased.
pub fn generate_board(contract: &AccountId, round: u64) -> (Board, u8, u8) {
    let seed = generation_seed(contract, round);
    let template_index = seed[0] % 8;
    let transform_index = seed[1] % 8;
    (transform(&template(usize::from(template_index)), transform_index), template_index, transform_index)
}

/// "BAG_HEIST_BOARD_V1\0" || 6 || start || exit || 36 x (tile, loot).
pub fn board_bytes(board: &Board) -> Vec<u8> {
    assert!(board.tiles.len() == CELLS && board.loot.len() == CELLS, "BOARD_SIZE");
    let mut output = b"BAG_HEIST_BOARD_V1\0".to_vec();
    output.extend_from_slice(&[SIZE as u8, board.start, board.exit]);
    for index in 0..CELLS {
        output.push(board.tiles[index]);
        output.push(board.loot[index]);
    }
    output
}

pub fn board_hash(board: &Board) -> [u8; 32] {
    env::sha256_array(&board_bytes(board))
}

pub struct CommitmentInput<'a> {
    pub contract: &'a str,
    pub player: &'a str,
    pub round: u64,
    pub board_hash: &'a [u8; 32],
    pub use_crowbar: bool,
    pub moves: &'a str,
    pub salt: &'a [u8; 32],
}

/// The exact preimage documented in RULES.md section 4.
pub fn commitment_bytes(input: &CommitmentInput) -> Vec<u8> {
    let mut output = b"BAG_HEIST_COMMIT_V1\0".to_vec();
    lp16(&mut output, NETWORK);
    lp16(&mut output, input.contract);
    lp16(&mut output, input.player);
    output.extend_from_slice(&input.round.to_le_bytes());
    output.extend_from_slice(input.board_hash);
    output.push(u8::from(input.use_crowbar));
    lp16(&mut output, input.moves);
    output.extend_from_slice(input.salt);
    output
}

pub fn commitment_digest(input: &CommitmentInput) -> [u8; 32] {
    env::sha256_array(&commitment_bytes(input))
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    output
}

/// Parses exactly 64 lowercase hexadecimal characters.
pub fn parse_hex32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let nibble = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    let mut output = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(output)
}

/// The route checker. Checks run in this order for every move: past exit,
/// move character, grid bounds, wall, revisit, door. See RULES.md section 3.
pub fn check_route(board: &Board, moves: &str, crowbar: bool) -> RouteCheck {
    let bytes = moves.as_bytes();
    let length = u16::try_from(bytes.len()).unwrap_or(u16::MAX);
    let mut tile = usize::from(board.start);
    let mut result = RouteCheck {
        valid: false,
        verdict: Verdict::Ok,
        loot: u16::from(board.loot[tile]),
        length,
        doors: 0,
        path: vec![board.start],
    };
    macro_rules! reject {
        ($verdict:expr) => {{
            result.verdict = $verdict;
            return result;
        }};
    }
    if bytes.len() > MAX_MOVES {
        reject!(Verdict::TooLong);
    }
    let mut seen: u64 = 1 << tile;
    for &direction in bytes {
        if tile == usize::from(board.exit) {
            reject!(Verdict::PastExit);
        }
        let (row, column) = (tile / SIZE, tile % SIZE);
        let next = match direction {
            b'U' | b'D' | b'L' | b'R' => match direction {
                b'U' if row > 0 => tile - SIZE,
                b'D' if row < SIZE - 1 => tile + SIZE,
                b'L' if column > 0 => tile - 1,
                b'R' if column < SIZE - 1 => tile + 1,
                _ => reject!(Verdict::OutOfBounds),
            },
            _ => reject!(Verdict::BadMove),
        };
        if board.tiles[next] == TILE_WALL {
            reject!(Verdict::Wall);
        }
        if seen & (1 << next) != 0 {
            reject!(Verdict::Revisit);
        }
        if board.tiles[next] == TILE_DOOR {
            if !crowbar {
                reject!(Verdict::DoorLocked);
            }
            if result.doors == 1 {
                reject!(Verdict::SecondDoor);
            }
            result.doors = 1;
        }
        seen |= 1 << next;
        tile = next;
        result.path.push(tile as u8);
        result.loot = result.loot.checked_add(u16::from(board.loot[tile])).expect("LOOT_OVERFLOW");
    }
    if tile != usize::from(board.exit) {
        reject!(Verdict::NotAtExit);
    }
    result.valid = true;
    result
}
