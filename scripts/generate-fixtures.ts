/**
 * Regenerates fixtures/vectors.json from the TypeScript engine.
 * The Rust unit tests and the Vitest suite both assert against this file,
 * so any divergence between the two implementations fails CI.
 *
 *   pnpm fixtures          # rewrite the file
 *   pnpm fixtures --check  # exit 1 if the committed file is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  boardBytes, boardHash, checkRoute, commitmentBytes, commitmentHash, generateBoard, hex,
  solveRoutes, template, transform, type CommitmentInput,
} from '../src/engine/rules';

const target = fileURLToPath(new URL('../fixtures/vectors.json', import.meta.url));

export function buildVectors() {
  const contracts = ['bag-heist.testnet', 'bagheist.eshaanvgupta.testnet', 'bag-heist.sandbox', 'vault.a-very-long-account-name-for-lp16-coverage.testnet'];
  const rounds = ['1', '2', '3', '7', '42', '1000', '18446744073709551615'];
  const boards = contracts.flatMap((contractId) =>
    rounds.map((roundId) => {
      const generated = generateBoard(contractId, roundId);
      return {
        contractId, roundId, seed: generated.seed, template: generated.template, transform: generated.transform,
        board: generated.board, preimage: hex(boardBytes(generated.board)), hash: boardHash(generated.board),
      };
    }),
  );

  const round1 = generateBoard('bag-heist.testnet', 1).board;
  const round2 = generateBoard('bag-heist.testnet', 2).board;
  const best = solveRoutes(round1, false)[0].moves;
  const base: CommitmentInput = {
    contractId: 'bag-heist.testnet', playerId: 'alice.testnet', roundId: '1', boardHash: boardHash(round1),
    useCrowbar: false, moves: best, salt: '11'.repeat(32),
  };
  const variants: [string, Partial<CommitmentInput>][] = [
    ['normal', {}],
    ['different player', { playerId: 'bob.testnet' }],
    ['different round', { roundId: '2' }],
    ['different board', { boardHash: boardHash(round2) }],
    ['different crowbar setting', { useCrowbar: true }],
    ['changed route', { moves: best.slice(0, -1) }],
    ['changed salt', { salt: '22'.repeat(32) }],
    ['different contract', { contractId: 'bag-heist-2.testnet' }],
    ['empty route', { moves: '' }],
    ['maximum round id', { roundId: '18446744073709551615' }],
  ];
  const commitments = variants.map(([name, change]) => {
    const input = { ...base, ...change, roundId: String(change.roundId ?? base.roundId) };
    return { name, input, preimage: hex(commitmentBytes(input)), hash: commitmentHash(input) };
  });

  const named: [string, number, number, string, boolean][] = [
    ['leaves the top edge', 0, 0, 'U', false],
    ['leaves the left edge', 0, 0, 'L', false],
    ['no wrap from column 5 to the next row', 0, 0, 'RDRRURRR', false],
    ['walks into a wall', 0, 0, 'D', false],
    ['revisits a tile', 0, 0, 'RDU', false],
    ['continues after the exit', 0, 0, 'RDDDDRRDRRU', false],
    ['door without a crowbar', 0, 0, 'RDDDR', false],
    ['second door with a crowbar', 0, 0, 'RDDDRDD', true],
    ['stops short of the exit', 0, 0, 'RD', false],
    ['empty route', 0, 0, '', false],
    ['lowercase move', 0, 0, 'r', false],
    ['unknown character', 0, 0, 'RX', false],
    ['non-ASCII character', 0, 0, 'RÜ', false],
    ['longer than 35 moves', 0, 0, 'R'.repeat(36), false],
    ['valid plain route', 0, 0, 'RDDDDRRDRR', false],
    ['valid single-door route', 0, 0, 'RDDDRRDDRR', true],
    ['crowbar flag without a door', 0, 0, 'RDDDDRRDRR', true],
    ['rotated board best route', 3, 1, solveRoutes(transform(template(3), 1), false)[0].moves, false],
    ['mirrored board best door route', 5, 6, solveRoutes(transform(template(5), 6), true).find((r) => r.doors === 1)!.moves, true],
  ];
  const routes = named.map(([name, t, tr, moves, crowbar]) => ({ name, template: t, transform: tr, moves, crowbar, expected: checkRoute(transform(template(t), tr), moves, crowbar) }));

  // Seeded random routes over every template and transform (xorshift32, seed recorded).
  const seed = 0x0bad_5eed;
  let state = seed;
  const rand = (n: number) => {
    state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    return state % n;
  };
  const alphabet = 'UDLRUDLRUDLRUDLRx';
  const differential = [];
  for (let t = 0; t < 8; t++) {
    for (let tr = 0; tr < 8; tr++) {
      const board = transform(template(t), tr);
      const solved = [...solveRoutes(board, false).slice(0, 3), ...solveRoutes(board, true).filter((r) => r.doors === 1).slice(0, 2)];
      for (const route of solved) differential.push({ template: t, transform: tr, moves: route.moves, crowbar: route.doors === 1 });
      for (let i = 0; i < 6; i++) {
        const length = rand(38);
        let moves = '';
        for (let j = 0; j < length; j++) moves += alphabet[rand(alphabet.length)];
        differential.push({ template: t, transform: tr, moves, crowbar: rand(2) === 1 });
      }
    }
  }
  return {
    description: 'Shared vectors for BAG HEIST. Generated by scripts/generate-fixtures.ts; asserted by cargo test and vitest.',
    differentialSeed: seed,
    boards,
    commitments,
    routes,
    differential: differential.map((c) => ({ ...c, expected: checkRoute(transform(template(c.template), c.transform), c.moves, c.crowbar) })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const json = JSON.stringify(buildVectors(), null, 1) + '\n';
  if (process.argv.includes('--check')) {
    const current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    if (current !== json) {
      console.error('fixtures/vectors.json is stale. Run `pnpm fixtures`.');
      process.exit(1);
    }
    console.log('fixtures/vectors.json is up to date.');
  } else {
    writeFileSync(target, json);
    const v = JSON.parse(json);
    console.log(`Wrote ${v.boards.length} boards, ${v.commitments.length} commitments, ${v.routes.length} named routes, ${v.differential.length} differential routes.`);
  }
}
