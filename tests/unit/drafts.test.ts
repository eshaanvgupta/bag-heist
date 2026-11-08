import { describe, it, expect } from 'vitest';
import {
  makeDraft,
  validateDraft,
  verifyDraftContext,
  saveDraft,
  findDrafts,
  importBackup,
  type RevealDraft,
} from '../../src/drafts';
import { generateBoard, boardHash } from '../../src/engine/rules';

class MemoryStorage implements Storage {
  private store: Record<string, string> = {};
  get length() { return Object.keys(this.store).length; }
  clear() { this.store = {}; }
  getItem(key: string) { return this.store[key] ?? null; }
  key(index: number) { return Object.keys(this.store)[index] ?? null; }
  removeItem(key: string) { delete this.store[key]; }
  setItem(key: string, value: string) { this.store[key] = value; }
}

describe('Drafts & Reveal Backups', () => {
  const contractId = 'bag-heist.testnet';
  const playerId = 'alice.testnet';
  const roundId = '1';
  const board = generateBoard(contractId, 1n).board;
  const bHash = boardHash(board);

  it('creates valid reveal drafts with matching commitment hash', () => {
    const draft = makeDraft({
      contractId,
      playerId,
      roundId,
      boardHash: bHash,
      useCrowbar: false,
      moves: 'DDLLLLDDLD',
    });

    expect(draft.version).toBe(1);
    expect(draft.network).toBe('near:testnet');
    expect(draft.commitmentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(draft.salt).toMatch(/^[0-9a-f]{64}$/);

    const validated = validateDraft(draft);
    expect(validated.commitmentHash).toBe(draft.commitmentHash);
  });

  it('validates context and rejects mismatched wallets', () => {
    const draft = makeDraft({
      contractId,
      playerId,
      roundId,
      boardHash: bHash,
      useCrowbar: false,
      moves: 'DDLLLLDDLD',
    });

    // Valid context
    expect(() => {
      verifyDraftContext(draft, {
        contractId,
        playerId,
        roundId,
        board,
        commitmentHash: draft.commitmentHash,
      });
    }).not.toThrow();

    // Wrong player
    expect(() => {
      verifyDraftContext(draft, {
        contractId,
        playerId: 'bob.testnet',
        roundId,
        board,
        commitmentHash: draft.commitmentHash,
      });
    }).toThrow('Wrong wallet');

    // Wrong round
    expect(() => {
      verifyDraftContext(draft, {
        contractId,
        playerId,
        roundId: '2',
        board,
        commitmentHash: draft.commitmentHash,
      });
    }).toThrow('another contract or round');
  });

  it('saves and finds drafts in storage', () => {
    const storage = new MemoryStorage();
    const draft = makeDraft({
      contractId,
      playerId,
      roundId,
      boardHash: bHash,
      useCrowbar: false,
      moves: 'DDLLLLDDLD',
    });

    saveDraft(draft, storage);
    const found = findDrafts({ contractId, playerId, roundId }, storage);
    expect(found.length).toBe(1);
    expect(found[0].commitmentHash).toBe(draft.commitmentHash);
  });

  it('exports and imports backup safely', () => {
    const storage = new MemoryStorage();
    const draft = makeDraft({
      contractId,
      playerId,
      roundId,
      boardHash: bHash,
      useCrowbar: false,
      moves: 'DDLLLLDDLD',
    });

    const exported = JSON.stringify(draft);
    const imported = importBackup(
      exported,
      {
        contractId,
        playerId,
        roundId,
        board,
        commitmentHash: draft.commitmentHash,
      },
      storage,
    );

    expect(imported.commitmentHash).toBe(draft.commitmentHash);
    const found = findDrafts({ contractId, playerId, roundId }, storage);
    expect(found.length).toBe(1);
  });
});

