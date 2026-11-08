import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Near } from './lib/near.mjs';
import { runScenario } from './lib/scenario.mjs';

const credentials = JSON.parse(readFileSync(new URL('../runtime/deployment-credentials.json', import.meta.url), 'utf8'));
const deployment = JSON.parse(readFileSync(new URL('../public/evidence/deployment.json', import.meta.url), 'utf8'));
const build = JSON.parse(readFileSync(new URL('../res/contract-build.json', import.meta.url), 'utf8'));
const near = new Near(credentials.rpc_url);
const tracePath = new URL('../runtime/testnet-walkthrough.json', import.meta.url);
if (existsSync(tracePath)) throw new Error('A walkthrough record already exists. Inspect it before creating another scenario.');
const trace = { network: 'testnet', contract_id: credentials.contract_id, started_at: new Date().toISOString(), steps: [] };
const save = () => writeFileSync(tracePath, JSON.stringify(trace, null, 2) + '\n');
save();
const crews = Object.fromEntries(['crewA', 'crewB', 'crewC'].map(role => { const key = credentials.credentials[role]; return [role, near.account(key.account_id, key.privateKey)]; }));
const outcome = await runScenario({ near, contractId: credentials.contract_id, crews, network: 'testnet',
  onRecord(record) { trace.steps.push(record); save(); },
  async waitForChainTime(target, label) {
    console.log(`waiting for ${label}; target ${target}`);
    while (true) {
      const block = await near.finalBlock();
      const remaining = target - BigInt(block.header.timestamp_nanosec);
      if (remaining <= 0n) return;
      await new Promise(resolve => setTimeout(resolve, Number(remaining / 1_000_000n) < 10_000 ? 1500 : 10_000));
    }
  },
});
Object.assign(trace, outcome, { finished_at: new Date().toISOString() }); save();
const evidence = {
  schema: 'bag-heist-testnet-evidence-v1', network: 'testnet', contract_id: credentials.contract_id,
  code_hash: deployment.code_hash, wasm_sha256: build.sha256, source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), verified_at: new Date().toISOString(),
  transactions: outcome.steps.map(record => ({ hash: record.tx_hash, signer_id: record.signer_id, method: record.method, outcome: record.outcome, explorer_url: `https://testnet.nearblocks.io/txns/${record.tx_hash}`, logs: record.logs, supply_before: record.before.total_supply, supply_after: record.after.total_supply, block_timestamp: record.block_timestamp, before: record.before, after: record.after })),
  final_state: outcome.final_state, rounds: outcome.rounds, crowbars: outcome.crowbars,
};
writeFileSync(new URL('../runtime/testnet-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(new URL('../public/evidence/testnet.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(`confirmed ${evidence.transactions.length} recorded testnet transactions`);
