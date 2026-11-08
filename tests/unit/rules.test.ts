import { describe, expect, it } from 'vitest';
import vectors from '../../fixtures/vectors.json';
import {
  boardBytes, boardHash, checkRoute, commitmentBytes, commitmentHash, generateBoard,
  hex, solveRoutes, template, transform,
} from '../../src/engine/rules';

describe('Rust/TypeScript rule parity', () => {
  it('reconstructs every deterministic board and hash', () => {
    for (const vector of vectors.boards) {
      const generated = generateBoard(vector.contractId, vector.roundId);
      expect(generated.seed).toBe(vector.seed);
      expect(generated.template).toBe(vector.template);
      expect(generated.transform).toBe(vector.transform);
      expect(generated.board).toEqual(vector.board);
      expect(hex(boardBytes(generated.board))).toBe(vector.preimage);
      expect(boardHash(generated.board)).toBe(vector.hash);
    }
  });

  it('matches every domain-separated commitment vector', () => {
    for (const vector of vectors.commitments) {
      expect(hex(commitmentBytes(vector.input))).toBe(vector.preimage);
      expect(commitmentHash(vector.input)).toBe(vector.hash);
    }
    expect(new Set(vectors.commitments.map(vector => vector.hash)).size).toBe(vectors.commitments.length);
  });

  it('matches named and seeded route results byte for byte', () => {
    for (const vector of [...vectors.routes, ...vectors.differential]) {
      const board = transform(template(vector.template), vector.transform);
      expect(checkRoute(board, vector.moves, vector.crowbar)).toEqual(vector.expected);
    }
  });

  it('finds ranked routes both without and with one crowbar', () => {
    const board = generateBoard('bag-heist.testnet', '1').board;
    const ordinary = solveRoutes(board, false);
    const breached = solveRoutes(board, true);
    expect(ordinary[0]).toMatchObject({ doors: 0 });
    expect(checkRoute(board, ordinary[0].moves, false).valid).toBe(true);
    expect(checkRoute(board, breached[0].moves, true).valid).toBe(true);
    expect(breached[0].loot).toBeGreaterThanOrEqual(ordinary[0].loot);
  });

  it('binds a reveal to its player identity', () => {
    const base = vectors.commitments[0].input;
    expect(commitmentHash(base)).not.toBe(commitmentHash({ ...base, playerId: 'copier.testnet' }));
  });
});
