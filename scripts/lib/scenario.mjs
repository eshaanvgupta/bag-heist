/**
 * The judge walkthrough as an executable script. The same code runs against a
 * local near-sandbox node (pnpm test:sandbox) and against NEAR testnet
 * (pnpm demo:testnet); only the network and the clock differ.
 *
 *  Round 1  three crews commit; crew C tries to reveal crew A's published
 *           route and salt and is rejected; real reveals are ranked; crew A
 *           wins, claims exactly 100 BAG, a second claim fails, and crew A
 *           burns 5 BAG on a crowbar.
 *  Round 2  crew A spends the crowbar and wins through a locked door.
 *  Round 3  a crew commits but nobody reveals; finalization burns 100 BAG.
 */
import { randomBytes } from 'node:crypto';
import { boardHash, commitmentHash, solveRoutes } from '../../src/engine/rules.ts';
import { DEPOSITS, callContract, summarizeOutcome } from './near.mjs';

const salt = () => randomBytes(32).toString('hex');

export async function runScenario({ near, contractId, crews, waitForChainTime, log = console.log, network, onRecord = () => {} }) {
  const steps = [];
  const ids = Object.fromEntries(Object.entries(crews).map(([k, v]) => [k, v.accountId]));
  const watched = [contractId, ...Object.values(ids)];

  async function snapshot(blockId) {
    const state = await near.view(contractId, 'get_state', {}, blockId);
    const balances = {};
    for (const id of watched) balances[id] = await near.view(contractId, 'ft_balance_of', { account_id: id }, blockId);
    return { total_supply: state.total_supply, treasury: state.treasury_balance, reserved: state.reserved_prizes, unallocated: state.unallocated_game_budget, balances };
  }

  async function step(label, crew, method, args, { deposit = 0n, expect = 'success', expectError, roundId } = {}) {
    const account = crews[crew];
    const before = await snapshot();
    const result = await callContract(account, contractId, method, args, { deposit });
    const summary = summarizeOutcome(result);
    const block = await near.rpc('block', { block_id: summary.first_receipt_block });
    const after = await snapshot();
    const round = roundId ? await near.view(contractId, 'get_round', { round_id: String(roundId) }) : null;
    const record = {
      step: steps.length + 1,
      label,
      method,
      signer_id: account.accountId,
      args,
      deposit: String(deposit),
      expected: expect,
      ...(expectError ? { expected_error: expectError } : {}),
      ...summary,
      block_height: block.header.height,
      block_hash: block.header.hash,
      block_timestamp: block.header.timestamp_nanosec,
      before,
      after,
      round,
    };
    delete record.first_receipt_block;
    steps.push(record);
    await onRecord(record);
    const mark = record.outcome === expect && (!expectError || record.error?.includes(expectError)) ? 'ok ' : 'ERR';
    log(`${mark} #${record.step} ${label} -> ${record.outcome}${record.error ? ` (${record.error})` : ''}  ${record.tx_hash}`);
    if (mark === 'ERR') throw new Error(`Step "${label}" expected ${expect}${expectError ? ` ${expectError}` : ''}, got ${record.outcome} ${record.error ?? ''}`);
    return record;
  }

  const sealed = {};
  async function commit(crew, round, moves, useCrowbar, label) {
    const s = salt();
    const hash = commitmentHash({ contractId, playerId: ids[crew], roundId: round.id, boardHash: round.board_hash, useCrowbar, moves, salt: s });
    sealed[crew] = { moves, salt: s, useCrowbar };
    await step(label, crew, 'commit_solution', { round_id: round.id, commitment_hash: hash, use_crowbar: useCrowbar }, { deposit: DEPOSITS.commitment, roundId: round.id });
  }
  const reveal = (crew, round, label, opts = {}) => {
    const source = opts.copyFrom ? sealed[opts.copyFrom] : sealed[crew];
    return step(label, crew, 'reveal_solution', { round_id: round.id, moves: source.moves, salt: source.salt }, { roundId: round.id, ...opts });
  };
  const open = async (crew, label) => (await step(label, crew, 'open_round', {}, { deposit: DEPOSITS.round })).return_value;

  // --- setup
  const bounds = await near.view(contractId, 'storage_balance_bounds');
  for (const crew of Object.keys(crews)) {
    await step(`${crew} registers a game profile`, crew, 'register_profile', {}, { deposit: DEPOSITS.profile });
    await step(`${crew} registers BAG token storage`, crew, 'storage_deposit', {}, { deposit: BigInt(bounds.min) });
  }

  // --- round 1
  const r1 = await open('crewB', 'Crew B opens round 1 (100 BAG reserved)');
  if (boardHash(r1.board) !== r1.board_hash) throw new Error('Board hash recomputed off-chain does not match the contract');
  const plain1 = solveRoutes(r1.board, false);
  await commit('crewA', r1, plain1[0].moves, false, 'Crew A seals its best route');
  await commit('crewB', r1, plain1[Math.floor(plain1.length / 2)].moves, false, 'Crew B seals a different route');
  await commit('crewC', r1, plain1[plain1.length - 1].moves, false, 'Crew C seals a route');
  await waitForChainTime(BigInt(r1.commitment_end), 'commitment window of round 1');
  await reveal('crewA', r1, 'Crew A reveals: route and salt are now public');
  await reveal('crewC', r1, 'Crew C replays crew A\'s revealed route and salt', { copyFrom: 'crewA', expect: 'failure', expectError: 'COMMITMENT_MISMATCH' });
  await reveal('crewB', r1, 'Crew B reveals its own route');
  await reveal('crewC', r1, 'Crew C reveals its own route');
  await waitForChainTime(BigInt(r1.reveal_end), 'reveal window of round 1');
  const f1 = await step('Crew B finalizes round 1', 'crewB', 'finalize_round', { round_id: r1.id }, { roundId: r1.id });
  if (f1.return_value.winner !== ids.crewA) throw new Error(`Expected crew A to win round 1, got ${f1.return_value.winner}`);
  await step('Crew A claims the 100 BAG prize', 'crewA', 'claim_reward', { round_id: r1.id }, { deposit: 1n, roundId: r1.id });
  await step('Crew A tries to claim again', 'crewA', 'claim_reward', { round_id: r1.id }, { deposit: 1n, expect: 'failure', expectError: 'ALREADY_CLAIMED', roundId: r1.id });
  await step('Crew A burns 5 BAG to craft a crowbar', 'crewA', 'craft_crowbar', {}, { deposit: 1n });

  // --- round 2
  const r2 = await open('crewC', 'Crew C opens round 2');
  const door = solveRoutes(r2.board, true).find((r) => r.doors === 1);
  const plain2 = solveRoutes(r2.board, false)[0];
  await commit('crewA', r2, door.moves, true, 'Crew A seals a door route and spends its crowbar');
  await commit('crewB', r2, plain2.moves, false, 'Crew B seals the best crowbar-free route');
  await waitForChainTime(BigInt(r2.commitment_end), 'commitment window of round 2');
  await reveal('crewA', r2, 'Crew A reveals a route through one locked door');
  await reveal('crewB', r2, 'Crew B reveals');
  await waitForChainTime(BigInt(r2.reveal_end), 'reveal window of round 2');
  const f2 = await step('Crew B finalizes round 2', 'crewB', 'finalize_round', { round_id: r2.id }, { roundId: r2.id });
  const winner2 = Object.keys(ids).find(crew => ids[crew] === f2.return_value.winner);
  if (!winner2) throw new Error('Round 2 did not produce a recorded winner');
  await step(`${winner2} claims round 2`, winner2, 'claim_reward', { round_id: r2.id }, { deposit: 1n, roundId: r2.id });

  // --- round 3
  const r3 = await open('crewA', 'Crew A opens round 3');
  await commit('crewB', r3, solveRoutes(r3.board, false)[0].moves, false, 'Crew B seals a route and never reveals it');
  await waitForChainTime(BigInt(r3.reveal_end), 'both windows of round 3');
  const f3 = await step('Crew C finalizes round 3 with zero reveals', 'crewC', 'finalize_round', { round_id: r3.id }, { roundId: r3.id });
  if (!f3.return_value.burned) throw new Error('Expected round 3 to burn its pot');

  const rounds = [];
  for (const id of [r1.id, r2.id, r3.id]) rounds.push(await near.view(contractId, 'get_round', { round_id: id }));
  const crowbars = await near.view(contractId, 'get_crowbars', { account_id: ids.crewA });
  const profiles = {};
  for (const [crew, id] of Object.entries(ids)) profiles[crew] = await near.view(contractId, 'get_profile', { account_id: id });
  return { network, steps, rounds, crowbars, profiles, final_state: await near.view(contractId, 'get_state') };
}
