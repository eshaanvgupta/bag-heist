import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import build from '../res/contract-build.json';
import vectors from '../fixtures/vectors.json';
import { boardBytes, boardHash, checkRoute, commitmentBytes, commitmentHash, generateBoard, template, transform } from '../src/engine/rules';

const root = resolve(import.meta.dirname, '..');
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
let failures = 0;
const pass = (message: string) => console.log(`confirmed   ${message}`);
const fail = (message: string) => { failures++; console.error(`mismatching ${message}`); };

function verifyRelease() {
  const wasm = readFileSync(resolve(root, build.artifact));
  const digest = sha256(wasm);
  digest === build.sha256 ? pass(`WASM ${wasm.length} bytes ${digest}`) : fail(`WASM hash ${digest}; recorded ${build.sha256}`);

  for (const [file, recorded] of Object.entries(build.source_sha256)) {
    const actual = sha256(readFileSync(resolve(root, 'contracts/bag-heist', file)));
    actual === recorded ? pass(`source ${file}`) : fail(`source ${file}`);
  }

  for (const item of vectors.boards) {
    const generated = generateBoard(item.contractId, item.roundId);
    if (generated.seed !== item.seed || generated.template !== item.template || generated.transform !== item.transform || boardHash(generated.board) !== item.hash || hex(boardBytes(generated.board)) !== item.preimage) fail(`board round ${item.roundId}`);
  }
  pass(`${vectors.boards.length} board vectors`);

  for (const item of vectors.commitments) {
    if (commitmentHash(item.input) !== item.hash || hex(commitmentBytes(item.input)) !== item.preimage) fail(`commitment ${item.name}`);
  }
  pass(`${vectors.commitments.length} commitment vectors`);

  for (const item of [...vectors.routes, ...vectors.differential]) {
    const actual = checkRoute(transform(template(item.template), item.transform), item.moves, item.crowbar);
    if (JSON.stringify(actual) !== JSON.stringify(item.expected)) fail(`route ${'name' in item ? item.name : item.moves}`);
  }
  pass(`${vectors.routes.length + vectors.differential.length} route vectors`);
}

type Evidence = {
  schema: string; network: string; contract_id: string; code_hash: string; wasm_sha256: string;
  source_commit: string; verified_at: string;
  transactions: Array<{ hash: string; signer_id: string; method: string; outcome: 'success' | 'failure'; explorer_url: string }>;
};

async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'bag-heist-verifier', method, params }) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

async function verifyChain(evidence: Evidence) {
  const url = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
  if (evidence.schema !== 'bag-heist-testnet-evidence-v1' || evidence.network !== 'testnet' || evidence.wasm_sha256 !== build.sha256) fail('evidence identity');
  const code = await rpc<{ code_hash: string }>(url, 'query', { request_type: 'view_code', finality: 'final', account_id: evidence.contract_id });
  code.code_hash === evidence.code_hash ? pass(`on-chain code ${code.code_hash}`) : fail(`on-chain code ${code.code_hash}; recorded ${evidence.code_hash}`);

  for (const item of evidence.transactions) {
    try {
      const transaction = await rpc<any>(url, 'tx', { tx_hash: item.hash, sender_account_id: item.signer_id, wait_until: 'FINAL' });
      const status = transaction?.final_execution_status;
      if (status !== 'FINAL') { console.error(`pending     ${item.hash}`); failures++; continue; }
      const action = transaction?.transaction?.actions?.find((value: any) => value.FunctionCall)?.FunctionCall;
      const failed = Boolean(transaction?.status?.Failure);
      if (action?.method_name !== item.method || (failed ? 'failure' : 'success') !== item.outcome) fail(`${item.hash} method/outcome`);
      else pass(`${item.hash} ${item.method} ${item.outcome}`);
    } catch (error) {
      console.error(`unavailable ${item.hash} ${error instanceof Error ? error.message : String(error)}`);
      failures++;
    }
  }
}

verifyRelease();
if (process.argv.includes('--release-only')) process.exit(failures ? 1 : 0);

const candidates = [resolve(root, 'runtime/testnet-evidence.json'), resolve(root, 'public/evidence/testnet.json')];
const evidencePath = candidates.find(existsSync);
if (!evidencePath) {
  console.error('unavailable testnet evidence: deploy and record runtime/testnet-evidence.json');
  process.exit(2);
}

try { await verifyChain(JSON.parse(readFileSync(evidencePath, 'utf8')) as Evidence); }
catch (error) { console.error(`unavailable testnet RPC: ${error instanceof Error ? error.message : String(error)}`); failures++; }
process.exit(failures ? 1 : 0);
