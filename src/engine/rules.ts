/**
 * TypeScript port of contracts/bag-heist/src/board.rs. Both implementations
 * are checked against fixtures/vectors.json (Rust: cargo test, TS: vitest).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import templateRows from '../../fixtures/templates.json';

export const NETWORK = 'near:testnet';
export const SIZE = 6;
export const CELLS = 36;
export const MAX_MOVES = 35;
export const TILE_OPEN = 0;
export const TILE_WALL = 1;
export const TILE_DOOR = 2;

export const TEMPLATES: readonly (readonly string[])[] = templateRows;
export const TEMPLATE_NAMES = ['Lobby', 'Counting House', 'Night Desk', 'Cold Storage', 'Deposit Row', 'Server Hall', 'Gallery', 'Loading Dock'] as const;
export const TRANSFORM_NAMES = ['as drawn', 'rotated 90°', 'rotated 180°', 'rotated 270°', 'mirrored', 'mirrored, 90°', 'mirrored, 180°', 'mirrored, 270°'] as const;

export interface Board {
  start: number;
  exit: number;
  tiles: number[];
  loot: number[];
}

export type Verdict =
  | 'OK'
  | 'TOO_LONG'
  | 'BAD_MOVE'
  | 'PAST_EXIT'
  | 'OUT_OF_BOUNDS'
  | 'WALL'
  | 'REVISIT'
  | 'DOOR_LOCKED'
  | 'SECOND_DOOR'
  | 'NOT_AT_EXIT';

export interface RouteCheck {
  valid: boolean;
  verdict: Verdict;
  loot: number;
  length: number;
  doors: number;
  path: number[];
}

export interface CommitmentInput {
  contractId: string;
  playerId: string;
  roundId: bigint | string;
  boardHash: string;
  useCrowbar: boolean;
  moves: string;
  salt: string;
}

const encoder = new TextEncoder();

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function isHex32(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function parseHex32(value: string): Uint8Array {
  if (!isHex32(value)) throw new Error('Expected 64 lowercase hexadecimal characters');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function lp16(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  if (bytes.length > 0xffff) throw new Error('LP16 overflow');
  return concat([Uint8Array.of(bytes.length & 0xff, bytes.length >>> 8), bytes]);
}

export function u64le(value: bigint | string | number): Uint8Array {
  const n = BigInt(value);
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new Error('u64 out of range');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

export function template(index: number): Board {
  const rows = TEMPLATES[index];
  if (!rows) throw new Error(`Unknown template ${index}`);
  const board: Board = { start: 0, exit: 0, tiles: Array(CELLS).fill(TILE_OPEN), loot: Array(CELLS).fill(0) };
  rows.forEach((line, row) => {
    if (line.length !== SIZE) throw new Error('Template width');
    [...line].forEach((cell, column) => {
      const tile = row * SIZE + column;
      if (cell === 'S') board.start = tile;
      else if (cell === 'E') board.exit = tile;
      else if (cell === '#') board.tiles[tile] = TILE_WALL;
      else if (cell === 'D') board.tiles[tile] = TILE_DOOR;
      else if (/^[1-9]$/.test(cell)) board.loot[tile] = Number(cell);
      else if (cell !== '.') throw new Error(`Unknown template tile ${cell}`);
    });
  });
  return board;
}

/** Reflect columns when transform >= 4, then rotate clockwise transform % 4 times. */
export function transform(board: Board, t: number): Board {
  if (!Number.isInteger(t) || t < 0 || t > 7) throw new Error('Transform must be 0-7');
  const out: Board = { start: 0, exit: 0, tiles: Array(CELLS).fill(TILE_OPEN), loot: Array(CELLS).fill(0) };
  for (let old = 0; old < CELLS; old++) {
    let row = Math.floor(old / SIZE);
    let column = old % SIZE;
    if (t >= 4) column = SIZE - 1 - column;
    for (let i = 0; i < t % 4; i++) [row, column] = [column, SIZE - 1 - row];
    const next = row * SIZE + column;
    out.tiles[next] = board.tiles[old];
    out.loot[next] = board.loot[old];
    if (old === board.start) out.start = next;
    if (old === board.exit) out.exit = next;
  }
  return out;
}

export function generationSeed(contractId: string, roundId: bigint | string | number): Uint8Array {
  return sha256(concat([encoder.encode('BAG_HEIST_GENERATE_V1\0'), lp16(contractId), u64le(roundId)]));
}

export function generateBoard(contractId: string, roundId: bigint | string | number) {
  const seed = generationSeed(contractId, roundId);
  const templateIndex = seed[0] % 8;
  const transformIndex = seed[1] % 8;
  return { board: transform(template(templateIndex), transformIndex), template: templateIndex, transform: transformIndex, seed: hex(seed) };
}

export function validateBoard(board: Board): void {
  const ok =
    board &&
    Array.isArray(board.tiles) &&
    Array.isArray(board.loot) &&
    board.tiles.length === CELLS &&
    board.loot.length === CELLS &&
    board.tiles.every((t) => t === 0 || t === 1 || t === 2) &&
    board.loot.every((l) => Number.isInteger(l) && l >= 0 && l <= 9) &&
    [board.start, board.exit].every((x) => Number.isInteger(x) && x >= 0 && x < CELLS) &&
    board.start !== board.exit;
  if (!ok) throw new Error('Malformed board');
}

/** "BAG_HEIST_BOARD_V1\0" || 6 || start || exit || 36 x (tile, loot). */
export function boardBytes(board: Board): Uint8Array {
  validateBoard(board);
  const cells = new Uint8Array(CELLS * 2);
  for (let i = 0; i < CELLS; i++) {
    cells[i * 2] = board.tiles[i];
    cells[i * 2 + 1] = board.loot[i];
  }
  return concat([encoder.encode('BAG_HEIST_BOARD_V1\0'), Uint8Array.of(SIZE, board.start, board.exit), cells]);
}

export const boardHash = (board: Board): string => hex(sha256(boardBytes(board)));

export function commitmentBytes(input: CommitmentInput): Uint8Array {
  return concat([
    encoder.encode('BAG_HEIST_COMMIT_V1\0'),
    lp16(NETWORK),
    lp16(input.contractId),
    lp16(input.playerId),
    u64le(input.roundId),
    parseHex32(input.boardHash),
    Uint8Array.of(input.useCrowbar ? 1 : 0),
    lp16(input.moves),
    parseHex32(input.salt),
  ]);
}

export const commitmentHash = (input: CommitmentInput): string => hex(sha256(commitmentBytes(input)));

export function randomSalt(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

const STEP: Record<number, number> = { 85: -SIZE, 68: SIZE, 76: -1, 82: 1 }; // U D L R

/** Same check order as the contract: past exit, move byte, bounds, wall, revisit, door. */
export function checkRoute(board: Board, moves: string, crowbar = false): RouteCheck {
  const bytes = encoder.encode(moves);
  let tile = board.start;
  const result: RouteCheck = { valid: false, verdict: 'OK', loot: board.loot[tile], length: bytes.length, doors: 0, path: [tile] };
  const reject = (verdict: Verdict): RouteCheck => ({ ...result, verdict, valid: false });
  if (bytes.length > MAX_MOVES) return reject('TOO_LONG');
  const seen = new Set([tile]);
  for (const byte of bytes) {
    if (tile === board.exit) return reject('PAST_EXIT');
    const step = STEP[byte];
    if (step === undefined) return reject('BAD_MOVE');
    const row = Math.floor(tile / SIZE);
    const column = tile % SIZE;
    if ((byte === 85 && row === 0) || (byte === 68 && row === SIZE - 1) || (byte === 76 && column === 0) || (byte === 82 && column === SIZE - 1)) {
      return reject('OUT_OF_BOUNDS');
    }
    const next = tile + step;
    if (board.tiles[next] === TILE_WALL) return reject('WALL');
    if (seen.has(next)) return reject('REVISIT');
    if (board.tiles[next] === TILE_DOOR) {
      if (!crowbar) return reject('DOOR_LOCKED');
      if (result.doors === 1) return reject('SECOND_DOOR');
      result.doors = 1;
    }
    seen.add(next);
    tile = next;
    result.path = [...result.path, tile];
    result.loot += board.loot[tile];
  }
  if (tile !== board.exit) return reject('NOT_AT_EXIT');
  return { ...result, valid: true, verdict: 'OK' };
}

export interface SolvedRoute {
  moves: string;
  loot: number;
  length: number;
  doors: number;
}

/** Exhaustive search for every valid route, best first (loot desc, length asc, moves). */
export function solveRoutes(board: Board, crowbar: boolean, cap = 250_000): SolvedRoute[] {
  const routes: SolvedRoute[] = [];
  let visits = 0;
  const walk = (tile: number, moves: string, seen: bigint, doors: number, loot: number) => {
    if (++visits > cap) return;
    if (tile === board.exit) {
      routes.push({ moves, loot, length: moves.length, doors });
      return;
    }
    if (moves.length === MAX_MOVES) return;
    const row = Math.floor(tile / SIZE);
    const column = tile % SIZE;
    const options: [string, boolean, number][] = [
      ['U', row > 0, tile - SIZE],
      ['D', row < SIZE - 1, tile + SIZE],
      ['L', column > 0, tile - 1],
      ['R', column < SIZE - 1, tile + 1],
    ];
    for (const [move, inside, next] of options) {
      if (!inside || board.tiles[next] === TILE_WALL) continue;
      const bit = 1n << BigInt(next);
      if (seen & bit) continue;
      const door = board.tiles[next] === TILE_DOOR ? 1 : 0;
      if (doors + door > (crowbar ? 1 : 0)) continue;
      walk(next, moves + move, seen | bit, doors + door, loot + board.loot[next]);
    }
  };
  walk(board.start, '', 1n << BigInt(board.start), 0, board.loot[board.start]);
  return routes.sort((a, b) => b.loot - a.loot || a.length - b.length || (a.moves < b.moves ? -1 : a.moves > b.moves ? 1 : 0));
}

export interface ScoreKey {
  loot: number;
  length: number;
  sequence: number;
}

/** More loot, then fewer moves, then the earlier commitment sequence. */
export function scoreBeats(a: ScoreKey, b: ScoreKey): boolean {
  if (a.loot !== b.loot) return a.loot > b.loot;
  if (a.length !== b.length) return a.length < b.length;
  return a.sequence < b.sequence;
}

/** Tile index after applying a single move, or null when it would leave the grid. */
export function stepFrom(tile: number, move: 'U' | 'D' | 'L' | 'R'): number | null {
  const row = Math.floor(tile / SIZE);
  const column = tile % SIZE;
  if (move === 'U') return row > 0 ? tile - SIZE : null;
  if (move === 'D') return row < SIZE - 1 ? tile + SIZE : null;
  if (move === 'L') return column > 0 ? tile - 1 : null;
  return column < SIZE - 1 ? tile + 1 : null;
}

/** The move that goes from one tile to an orthogonally adjacent tile, if any. */
export function moveBetween(from: number, to: number): 'U' | 'D' | 'L' | 'R' | null {
  for (const move of ['U', 'D', 'L', 'R'] as const) if (stepFrom(from, move) === to) return move;
  return null;
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  OK: 'Clean getaway',
  TOO_LONG: 'Longer than 35 moves',
  BAD_MOVE: 'Unknown move',
  PAST_EXIT: 'Keeps moving after the exit',
  OUT_OF_BOUNDS: 'Leaves the vault',
  WALL: 'Runs into a wall',
  REVISIT: 'Crosses its own path',
  DOOR_LOCKED: 'Door is locked — needs a crowbar',
  SECOND_DOOR: 'A crowbar opens only one door',
  NOT_AT_EXIT: 'Not at the exit yet',
};
