#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider } from 'near-api-js';
import { DEFAULT_PRIVATE_KEY, DEFAULT_PUBLIC_KEY, Sandbox } from 'near-sandbox';
import { runLinux, toLinuxPath } from './lib/linux.mjs';

if (process.platform === 'win32' && !process.env.BAG_HEIST_IN_WSL) {
  const result = runLinux(['node', toLinuxPath(fileURLToPath(import.meta.url))], {
    env: { BAG_HEIST_IN_WSL: '1', DIR_TO_DOWNLOAD_BINARY: '/root/.cache/near-sandbox-bin' },
  });
  process.exit(result.status ?? 1);
}

const wasm = readFileSync(new URL('../res/bag_heist.wasm', import.meta.url));
const GAS = 200_000_000_000_000n;
const YOCTO = 10n ** 24n;
const PROFILE = 5_000_000_000_000_000_000_000n;
const ROUND = 20_000_000_000_000_000_000_000n;
const COMMIT = 20_000_000_000_000_000_000_000n;
const FT_STORAGE = 1_250_000_000_000_000_000_000n;

const lp16 = (value) => { const bytes = Buffer.from(value); const length = Buffer.alloc(2); length.writeUInt16LE(bytes.length); return Buffer.concat([length, bytes]); };
const u64 = (value) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const digest = ({ contract, player, round, board, moves, salt }) => createHash('sha256').update(Buffer.concat([
  Buffer.from('BAG_HEIST_COMMIT_V1\0'), lp16('near:testnet'), lp16(contract), lp16(player), u64(round),
  Buffer.from(board, 'hex'), Buffer.from([0]), lp16(moves), Buffer.from(salt, 'hex'),
])).digest('hex');

function route(board) {
  const queue = [{ tile: board.start, moves: '', seen: new Set([board.start]) }];
  const choices = [['U', -6], ['D', 6], ['L', -1], ['R', 1]];
  while (queue.length) {
    const item = queue.shift();
    if (item.tile === board.exit) return item.moves;
    for (const [move, delta] of choices) {
      const row = Math.floor(item.tile / 6), col = item.tile % 6;
      if ((move === 'U' && row === 0) || (move === 'D' && row === 5) || (move === 'L' && col === 0) || (move === 'R' && col === 5)) continue;
      const next = item.tile + delta;
      if (board.tiles[next] !== 0 || item.seen.has(next)) continue;
      queue.push({ tile: next, moves: item.moves + move, seen: new Set([...item.seen, next]) });
    }
  }
  throw new Error('Generated board has no ordinary route.');
}

async function fastForward(rpcUrl, blocks) {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'fast-forward', method: 'sandbox_fast_forward', params: [blocks] }) });
  const body = await response.json();
  if (body.error) throw new Error(`sandbox_fast_forward: ${body.error.message}`);
}

async function waitForPhase(provider, contractId, phase) {
  let round;
  for (let attempt = 0; attempt < 50; attempt++) {
    round = await provider.callFunction({ contractId, method: 'get_round', args: { round_id: '1' } });
    if (round.phase === phase) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const block = await provider.viewBlock({ finality: 'optimistic' });
  throw new Error(`Sandbox did not reach ${phase}; block=${block.header.height} timestamp=${block.header.timestamp_nanosec} commitment_end=${round.commitment_end}.`);
}

const sandbox = await Sandbox.start({});
try {
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const rootAccount = new Account('sandbox', provider, DEFAULT_PRIVATE_KEY);
  await rootAccount.createSubAccount({ accountOrPrefix: 'contract', publicKey: DEFAULT_PUBLIC_KEY, nearToTransfer: 1_000n * YOCTO });
  await rootAccount.createSubAccount({ accountOrPrefix: 'alice', publicKey: DEFAULT_PUBLIC_KEY, nearToTransfer: 100n * YOCTO });
  const contractId = 'contract.sandbox', playerId = 'alice.sandbox';
  const contract = new Account(contractId, provider, DEFAULT_PRIVATE_KEY);
  const alice = new Account(playerId, provider, DEFAULT_PRIVATE_KEY);

  await contract.deployContract(wasm);
  await contract.callFunctionRaw({ contractId, methodName: 'new', args: {}, gas: GAS });
  await alice.callFunctionRaw({ contractId, methodName: 'register_profile', args: {}, deposit: PROFILE, gas: GAS });
  await alice.callFunctionRaw({ contractId, methodName: 'storage_deposit', args: { account_id: playerId, registration_only: true }, deposit: FT_STORAGE, gas: GAS });
  await alice.callFunctionRaw({ contractId, methodName: 'open_round', args: {}, deposit: ROUND, gas: GAS });

  const opened = await provider.callFunction({ contractId, method: 'get_round', args: { round_id: '1' } });
  const moves = route(opened.board);
  const salt = '11'.repeat(32);
  const commitmentHash = digest({ contract: contractId, player: playerId, round: 1, board: opened.board_hash, moves, salt });
  await alice.callFunctionRaw({ contractId, methodName: 'commit_solution', args: { round_id: '1', commitment_hash: commitmentHash, use_crowbar: false }, deposit: COMMIT, gas: GAS });

  await fastForward(sandbox.rpcUrl, 400);
  await waitForPhase(provider, contractId, 'reveal');
  await alice.callFunctionRaw({ contractId, methodName: 'reveal_solution', args: { round_id: '1', moves, salt }, gas: GAS });
  await fastForward(sandbox.rpcUrl, 400);
  await waitForPhase(provider, contractId, 'awaiting_finalization');
  await alice.callFunctionRaw({ contractId, methodName: 'finalize_round', args: { round_id: '1' }, gas: GAS });
  await alice.callFunctionRaw({ contractId, methodName: 'claim_reward', args: { round_id: '1' }, deposit: 1n, gas: GAS });

  const balance = await provider.callFunction({ contractId, method: 'ft_balance_of', args: { account_id: playerId } });
  const state = await provider.callFunction({ contractId, method: 'get_state', args: {} });
  const finalRound = await provider.callFunction({ contractId, method: 'get_round', args: { round_id: '1' } });
  if (balance !== '100000000' || !finalRound.claimed || finalRound.winner !== playerId || state.reserved_prizes !== '0' || !state.budget_identity_holds || !state.treasury_covers_budget || !state.supply_audit_holds) throw new Error('Final sandbox state failed its economic assertions.');

  let repeatedClaimFailed = false;
  try { await alice.callFunctionRaw({ contractId, methodName: 'claim_reward', args: { round_id: '1' }, deposit: 1n, gas: GAS }); }
  catch { repeatedClaimFailed = true; }
  if (!repeatedClaimFailed) throw new Error('Repeated claim unexpectedly succeeded.');
  console.log(`confirmed actual NEAR sandbox ${sandbox.rpcUrl}`);
  console.log(`confirmed compiled WASM ${wasm.length} bytes deployed and initialized`);
  console.log(`confirmed commit → reveal → finalize → 100 BAG claim; repeat claim rejected`);
  console.log(`confirmed budget, treasury coverage, and supply audits`);
} finally {
  await sandbox.tearDown();
}
