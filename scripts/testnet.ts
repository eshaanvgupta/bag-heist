import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import build from '../res/contract-build.json';
import deployment from '../public/evidence/deployment.json';

const root = resolve(import.meta.dirname, '..');
const artifact = resolve(root, build.artifact);
const rpcUrl = process.env.NEAR_RPC_URL || deployment.rpc_url;
const contract = process.env.NEAR_CONTRACT_ID || deployment.contract_id;

async function prepare() {
  if (!existsSync(artifact)) throw new Error('Missing contract artifact; run pnpm build:contract.');
  const bytes = readFileSync(artifact);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== build.sha256) throw new Error(`Artifact hash mismatch: ${digest}`);
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'bag-heist-prepare', method: 'status', params: [] }) });
  if (!response.ok) throw new Error(`RPC unavailable: HTTP ${response.status}`);
  const status = await response.json() as any;
  console.log(`confirmed artifact ${bytes.length} bytes ${digest}`);
  console.log(`confirmed RPC ${status.result?.chain_id} block ${status.result?.sync_info?.latest_block_height}`);
  console.log(`planned contract ${contract}`);
  console.log(`near contract deploy ${contract} use-file res/bag_heist.wasm without-init-call network-config testnet sign-with-keychain send`);
  console.log(`near contract call-function as-transaction ${contract} new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send`);
  if (contract.startsWith('<')) console.log('authorization required: set NEAR_CONTRACT_ID and use the authorized NEAR keychain');
}

function demo() {
  const path = [resolve(root, 'runtime/testnet-evidence.json'), resolve(root, 'public/evidence/testnet.json')].find(existsSync);
  if (!path) {
    console.error('unavailable: no verified testnet evidence. Follow TESTNET.md after authorized deployment.');
    process.exit(2);
  }
  const evidence = JSON.parse(readFileSync(path, 'utf8')) as any;
  console.log(`contract ${evidence.contract_id}`);
  console.log(`code ${evidence.code_hash}`);
  for (const [index, item] of evidence.transactions.entries()) console.log(`${index + 1}. ${item.outcome} ${item.method} ${item.hash} ${item.explorer_url}`);
  console.log('Run pnpm verify:testnet before presenting this record.');
}

const command = process.argv[2] || 'prepare';
if (command === 'prepare') await prepare();
else if (command === 'demo') demo();
else throw new Error('Use prepare or demo.');
