import { describe, it, expect } from 'vitest';
import { Practice, PRACTICE_CONTRACT } from '../../src/practice';
import { makeDraft } from '../../src/drafts';
import { solveRoutes } from '../../src/engine/rules';

class MemoryStorage implements Storage {
  private store: Record<string, string> = {};
  get length() { return Object.keys(this.store).length; }
  clear() { this.store = {}; }
  getItem(key: string) { return this.store[key] ?? null; }
  key(index: number) { return Object.keys(this.store)[index] ?? null; }
  removeItem(key: string) { delete this.store[key]; }
  setItem(key: string, value: string) { this.store[key] = value; }
}

describe('Practice Offline Engine', () => {
  it('runs complete round lifecycle, payout, and crafting', () => {
    const storage = new MemoryStorage();
    const practice = new Practice(storage);
    const player = 'you.testnet';

    expect(practice.snapshot(player).round).toBeNull();
    expect(practice.snapshot(player).economy.reserved_prizes).toBe('0');
    practice.open();
    // 1. Starting the heist opens round 1
    const snap1 = practice.snapshot(player);
    expect(snap1.round).toBeDefined();
    expect(snap1.round?.id).toBe('1');
    expect(snap1.round?.finalized).toBe(false);

    // 2. Register profile and FT
    practice.register(player);
    practice.registerFt(player);
    const snapRegistered = practice.snapshot(player);
    expect(snapRegistered.profile).toBeDefined();
    expect(snapRegistered.profile?.crowbars).toBe(0);
    expect(snapRegistered.ftRegistered).toBe(true);

    // 3. Find a winning route for this board
    const routes = solveRoutes(snap1.round!.board, false);
    expect(routes.length).toBeGreaterThan(0);
    const bestMove = routes[0].moves;

    // 4. Commit solution
    const draft = makeDraft({
      contractId: PRACTICE_CONTRACT,
      playerId: player,
      roundId: '1',
      boardHash: snap1.round!.board_hash,
      useCrowbar: false,
      moves: bestMove,
    });
    practice.commit(player, draft);

    const snapCommitted = practice.snapshot(player);
    expect(snapCommitted.commitment).toBeDefined();
    expect(snapCommitted.commitment?.sequence).toBe(1);

    // 5. Advance clock to reveal phase
    practice.advance(); // moves to reveal
    const snapRevealPhase = practice.snapshot(player);
    expect(snapRevealPhase.round?.finalized).toBe(false);

    // 6. Reveal solution
    practice.reveal(player, draft);
    const snapRevealed = practice.snapshot(player);
    expect(snapRevealed.commitment?.reveal?.valid).toBe(true);
    expect(snapRevealed.round?.best?.player_id).toBe(player);

    // 7. Advance clock to settle phase and finalize
    practice.advance(); // moves to settle
    practice.finalize();

    const snapFinal = practice.snapshot(player);
    expect(snapFinal.round?.finalized).toBe(true);
    expect(snapFinal.round?.winner).toBe(player);
    expect(snapFinal.round?.claimed).toBe(false);

    // 8. Claim prize (100 BAG)
    practice.claim(player, '1');
    const snapClaimed = practice.snapshot(player);
    expect(snapClaimed.round?.claimed).toBe(true);
    expect(snapClaimed.balance).toBe('100000000'); // 100 BAG

    // 9. Craft crowbar (costs 5 BAG)
    practice.craft(player);
    const snapCrafted = practice.snapshot(player);
    expect(snapCrafted.balance).toBe('95000000'); // 95 BAG
    expect(snapCrafted.profile?.crowbars).toBe(1);
    expect(snapCrafted.economy.total_supply).toBe(String(1_000_000_000_000n - 5_000_000n));

    // 10. Open round 2
    practice.open();
    const snapRound2 = practice.snapshot(player);
    expect(snapRound2.round?.id).toBe('2');
  });

  it('burns 100 BAG when round ends with zero valid reveals', () => {
    const storage = new MemoryStorage();
    const practice = new Practice(storage);
    const player = 'you.testnet';

    practice.open();
    // Advance through commit and reveal without any submissions
    practice.advance(); // into reveal
    practice.advance(); // into settle
    practice.finalize();

    const snap = practice.snapshot(player);
    expect(snap.round?.finalized).toBe(true);
    expect(snap.round?.burned).toBe(true);
    expect(snap.round?.winner).toBeNull();
    expect(snap.economy.cumulative_expired_pots_burned).toBe('100000000');
    expect(snap.economy.total_supply).toBe(String(1_000_000_000_000n - 100_000_000n));
  });
});

