import type { Board } from './engine/rules';

export type Mode = 'practice' | 'testnet' | 'replay';
export type Phase = 'commit' | 'reveal' | 'settle' | 'finalized';
export interface Config {
  network: string; contract_id: string; token_name: string; token_symbol: string; decimals: number; initial_supply: string;
  round_prize: string; crowbar_price: string; commitment_window_ns: string; reveal_window_ns: string;
  board_size: number; max_route_length: number; max_participants: number; max_crowbars: number; template_count: number;
  profile_deposit: string; round_deposit: string; commitment_deposit: string; storage_deposits_retained: boolean;
}
export interface Economy {
  current_round_id: string | null; current_phase?: string | null; round_count: string; profile_count: string; total_supply: string; treasury_balance: string;
  unallocated_game_budget: string; reserved_prizes: string; cumulative_rewards_paid: string;
  cumulative_expired_pots_burned: string; cumulative_crafting_burned: string;
  cumulative_storage_burned: string; cumulative_resolver_burned: string; block_timestamp: string; block_height: string;
  budget_identity_holds: boolean; treasury_covers_budget: boolean; supply_audit_holds: boolean;
}
export interface Profile { account_id?: string; crowbars: number; crafted: number; consumed: number; rounds_played: number; valid_reveals: number; wins: number; bag_won: string; registered_at: string }
export interface Score { player_id: string; loot: number; length: number; sequence: number }
export interface Round {
  id: string; board: Board; board_hash: string; opened_at: string; commitment_end: string; reveal_end: string;
  template: number; template_name: string; transform: number; opened_by: string; participants: number; valid_reveals: number;
  invalid_reveals: number; finalized: boolean; finalized_at: string | null; best: Score | null; winner: string | null;
  prize: string; claimed: boolean; burned: boolean; phase: 'commit' | 'reveal' | 'awaiting_finalization' | 'finalized';
}
export interface Reveal { valid: boolean; verdict: string; loot: number; length: number; doors: number; moves: string; revealed_at: string }
export interface Commitment {
  round_id?: string; player_id: string; commitment_hash: string; use_crowbar: boolean; crowbar_serial?: number | null;
  sequence: number; committed_at?: string; reveal: Reveal | null;
}
export interface Snapshot {
  config: Config; economy: Economy; round: Round | null; rounds: Round[]; profile: Profile | null;
  account: string | null; balance: string; ftRegistered: boolean; commitment: Commitment | null;
  commitments: Commitment[]; receivedAt: number;
}
export interface TxNotice { state: 'idle' | 'signing' | 'pending' | 'confirmed' | 'failed' | 'unavailable'; message: string; hash?: string }
export const nsNow = () => BigInt(Date.now()) * 1_000_000n;
export const phaseOf = (round: Round, now: bigint): Phase => round.finalized ? 'finalized' : now < BigInt(round.commitment_end) ? 'commit' : now < BigInt(round.reveal_end) ? 'reveal' : 'settle';
export function bag(value: string | bigint): string {
  const amount = BigInt(value), whole = amount / 1_000_000n, fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return whole.toLocaleString('en-US') + (fraction ? `.${fraction}` : '');
}
export function near(value: string): string {
  const amount = BigInt(value), whole = amount / 10n ** 24n;
  const fraction = (amount % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
export const short = (value: string, n = 8) => value.length > n * 2 + 3 ? `${value.slice(0, n)}…${value.slice(-n)}` : value;
