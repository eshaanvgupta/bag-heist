import { boardHash, checkRoute, commitmentHash, generateBoard } from './engine/rules';
import type { RevealDraft } from './drafts';
import { nsNow, phaseOf, type Commitment, type Economy, type Profile, type Round, type Snapshot, type Config } from './types';

export const PRACTICE_CONTRACT = 'practice.bag-heist.testnet';
export const PRACTICE_PLAYERS = ['you.testnet', 'rival.testnet'];
const KEY = 'bag-heist:practice:v1';
const PRIZE = 100_000_000n, PRICE = 5_000_000n, SUPPLY = 1_000_000_000_000n;
export const practiceConfig: Config = {
  network: 'near:testnet', contract_id: PRACTICE_CONTRACT, decimals: 6, initial_supply: String(SUPPLY),
  round_prize: String(PRIZE), crowbar_price: String(PRICE), commitment_window_ns: '120000000000', reveal_window_ns: '120000000000',
  token_name: 'Bag Heist', token_symbol: 'BAG', board_size: 6, max_route_length: 35, max_participants: 64, max_crowbars: 10, template_count: 8,
  profile_deposit: '5000000000000000000000', round_deposit: '20000000000000000000000', commitment_deposit: '20000000000000000000000', storage_deposits_retained: true,
};
interface PracticeData {
  version: 1; clockOffset: string; rounds: Round[]; profiles: Record<string, Profile>; balances: Record<string, string>;
  ftAccounts: string[]; commitments: Record<string, Commitment[]>; economy: Economy;
}
function fresh(): PracticeData {
  return { version: 1, clockOffset: '0', rounds: [], profiles: {}, balances: {}, ftAccounts: [], commitments: {}, economy: {
    current_round_id: null, current_phase: null, round_count: '0', profile_count: '0', total_supply: String(SUPPLY), treasury_balance: String(SUPPLY),
    unallocated_game_budget: String(SUPPLY), reserved_prizes: '0', cumulative_rewards_paid: '0', cumulative_expired_pots_burned: '0',
    cumulative_crafting_burned: '0', cumulative_storage_burned: '0', cumulative_resolver_burned: '0', block_timestamp: String(nsNow()), block_height: '0',
    budget_identity_holds: true, treasury_covers_budget: true, supply_audit_holds: true,
  } };
}
export class Practice {
  private data: PracticeData;
  constructor(private storage: Storage = localStorage) {
    try { const value = JSON.parse(storage.getItem(KEY) || 'null'); this.data = value?.version === 1 ? value : fresh(); }
    catch { this.data = fresh(); }
  }
  now() { return nsNow() + BigInt(this.data.clockOffset); }
  private save() { this.data.economy.block_timestamp = String(this.now()); this.storage.setItem(KEY, JSON.stringify(this.data)); }
  private latest() { const round = this.data.rounds.at(-1); if (!round) throw new Error('Open a round first.'); return round; }
  snapshot(account: string, roundId?: string): Snapshot {
    const round = (roundId ? this.data.rounds.find(r => r.id === roundId) : null) ?? this.data.rounds.at(-1) ?? null;
    return structuredClone({ config: practiceConfig, economy: { ...this.data.economy, block_timestamp: String(this.now()) },
      round, rounds: this.data.rounds.slice(-20).reverse(), profile: this.data.profiles[account] ?? null, account,
      balance: this.data.balances[account] ?? '0', ftRegistered: this.data.ftAccounts.includes(account),
      commitment: round ? this.data.commitments[round.id]?.find(c => c.player_id === account) ?? null : null,
      commitments: round ? this.data.commitments[round.id] ?? [] : [], receivedAt: Date.now() });
  }
  register(account: string) {
    if (this.data.profiles[account]) throw new Error('Game profile already registered.');
    this.data.profiles[account] = { crowbars: 0, crafted: 0, consumed: 0, rounds_played: 0, valid_reveals: 0, wins: 0, bag_won: '0', registered_at: String(this.now()) };
    this.data.economy.profile_count = String(BigInt(this.data.economy.profile_count) + 1n); this.save();
  }
  registerFt(account: string) { if (!this.data.ftAccounts.includes(account)) this.data.ftAccounts.push(account); this.save(); }
  open() {
    if (this.data.rounds.length && !this.latest().finalized) throw new Error('Finalize the current round first.');
    if (BigInt(this.data.economy.unallocated_game_budget) < PRIZE) throw new Error('The fixed treasury allocation is exhausted.');
    const id = String(BigInt(this.data.economy.round_count) + 1n), generated = generateBoard(PRACTICE_CONTRACT, id), board = generated.board, now = this.now();
    this.data.rounds.push({ id, board, board_hash: boardHash(board), template: generated.template, template_name: `Vault ${generated.template + 1}`, transform: generated.transform, opened_by: 'practice', opened_at: String(now), commitment_end: String(now + 120_000_000_000n), reveal_end: String(now + 240_000_000_000n), participants: 0, valid_reveals: 0, invalid_reveals: 0, finalized: false, finalized_at: null, best: null, winner: null, prize: String(PRIZE), claimed: false, burned: false, phase: 'commit' });
    this.data.commitments[id] = [];
    this.data.economy.current_round_id = id; this.data.economy.round_count = id;
    this.data.economy.unallocated_game_budget = String(BigInt(this.data.economy.unallocated_game_budget) - PRIZE);
    this.data.economy.reserved_prizes = String(BigInt(this.data.economy.reserved_prizes) + PRIZE); this.save();
  }
  advance() {
    const round = this.latest(), phase = phaseOf(round, this.now());
    const target = phase === 'commit' ? BigInt(round.commitment_end) : phase === 'reveal' ? BigInt(round.reveal_end) : this.now();
    this.data.clockOffset = String(BigInt(this.data.clockOffset) + target - this.now()); this.save();
  }
  commit(account: string, draft: RevealDraft) {
    const round = this.latest(), profile = this.data.profiles[account];
    if (phaseOf(round, this.now()) !== 'commit') throw new Error('Commitment window is closed.');
    if (!profile) throw new Error('Register your game profile first.');
    if (draft.roundId !== round.id || draft.playerId !== account || draft.contractId !== PRACTICE_CONTRACT || draft.boardHash !== round.board_hash) throw new Error('Commitment domain does not match this round.');
    if (this.data.commitments[round.id].some(c => c.player_id === account)) throw new Error('You already committed in this round.');
    if (round.participants >= 64) throw new Error('This round is full.');
    if (draft.useCrowbar && profile.crowbars < 1) throw new Error('Craft a crowbar first.');
    if (draft.useCrowbar) { profile.crowbars--; profile.consumed++; }
    round.participants++;
    profile.rounds_played++; this.data.commitments[round.id].push({ player_id: account, commitment_hash: draft.commitmentHash, use_crowbar: draft.useCrowbar, sequence: round.participants, reveal: null }); this.save();
  }
  reveal(account: string, draft: RevealDraft) {
    const round = this.latest();
    if (phaseOf(round, this.now()) !== 'reveal') throw new Error('Reveal is only available in the reveal window.');
    const record = this.data.commitments[round.id].find(c => c.player_id === account);
    if (!record) throw new Error('No commitment found for this player.');
    if (record.reveal) throw new Error('This commitment has already been revealed.');
    const hash = commitmentHash({ contractId: PRACTICE_CONTRACT, playerId: account, roundId: round.id, boardHash: round.board_hash, useCrowbar: record.use_crowbar, moves: draft.moves, salt: draft.salt });
    if (hash !== record.commitment_hash) throw new Error('COMMITMENT_MISMATCH: route or salt does not match your commitment.');
    const result = checkRoute(round.board, draft.moves, record.use_crowbar);
    record.reveal = { valid: result.valid, verdict: result.verdict, loot: result.loot, length: result.length, doors: result.doors, moves: draft.moves, revealed_at: String(this.now()) };
    if (result.valid) {
      round.valid_reveals++;
      this.data.profiles[account].valid_reveals++; const best = round.best, score = { player_id: account, loot: result.loot, length: result.length, sequence: record.sequence };
      if (!best || score.loot > best.loot || (score.loot === best.loot && (score.length < best.length || (score.length === best.length && score.sequence < best.sequence)))) round.best = score;
    } else {
      round.invalid_reveals++;
    }
    this.save();
  }
  finalize() {
    const round = this.latest();
    if (phaseOf(round, this.now()) !== 'settle') throw new Error(round.finalized ? 'Round is already finalized.' : 'Reveal window has not ended.');
    round.finalized = true; round.finalized_at = String(this.now()); round.phase = 'finalized'; round.winner = round.best?.player_id ?? null;
    if (round.winner) this.data.profiles[round.winner].wins++;
    if (!round.winner) {
      round.burned = true;
      this.data.economy.reserved_prizes = String(BigInt(this.data.economy.reserved_prizes) - PRIZE);
      this.data.economy.cumulative_expired_pots_burned = String(BigInt(this.data.economy.cumulative_expired_pots_burned) + PRIZE);
      this.data.economy.total_supply = String(BigInt(this.data.economy.total_supply) - PRIZE);
      this.data.economy.treasury_balance = String(BigInt(this.data.economy.treasury_balance) - PRIZE);
    }
    this.save();
  }
  claim(account: string, roundId: string) {
    const round = this.data.rounds.find(r => r.id === roundId);
    if (!round?.finalized || round.winner !== account) throw new Error('Only the recorded winner can claim.');
    if (round.claimed) throw new Error('Prize already claimed.');
    if (!this.data.ftAccounts.includes(account)) throw new Error('Register BAG token storage before claiming. Your prize remains reserved.');
    round.claimed = true;
    this.data.balances[account] = String(BigInt(this.data.balances[account] ?? '0') + PRIZE);
    this.data.economy.treasury_balance = String(BigInt(this.data.economy.treasury_balance) - PRIZE);
    this.data.economy.reserved_prizes = String(BigInt(this.data.economy.reserved_prizes) - PRIZE);
    this.data.economy.cumulative_rewards_paid = String(BigInt(this.data.economy.cumulative_rewards_paid) + PRIZE);
    const profile = this.data.profiles[account]; profile.bag_won = String(BigInt(profile.bag_won) + PRIZE); this.save();
  }
  craft(account: string) {
    const profile = this.data.profiles[account], balance = BigInt(this.data.balances[account] ?? '0');
    if (!profile) throw new Error('Register a profile first.');
    if (profile.crowbars >= 10) throw new Error('Crowbar inventory is full (10 maximum).');
    if (balance < PRICE) throw new Error('You need 5 BAG to craft a crowbar.');
    this.data.balances[account] = String(balance - PRICE); profile.crowbars++; profile.crafted++;
    this.data.economy.total_supply = String(BigInt(this.data.economy.total_supply) - PRICE);
    this.data.economy.cumulative_crafting_burned = String(BigInt(this.data.economy.cumulative_crafting_burned) + PRICE); this.save();
  }
}
