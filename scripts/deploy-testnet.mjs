import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Near, NEAR, newKeyPair, createAccount, deployAndInit, summarizeOutcome, codeHashOf } from './lib/near.mjs';

const directory = new URL('../runtime/', import.meta.url);
const path = new URL('deployment-credentials.json', directory);
const publicPath = new URL('../public/evidence/deployment.json', import.meta.url);
const rpcUrl = 'https://test.rpc.fastnear.com';
const near = new Near(rpcUrl);
if ((await near.status()).chain_id !== 'testnet') throw new Error('Wrong network');
mkdirSync(directory, { recursive: true });
let saved;
if (existsSync(path)) saved = JSON.parse(readFileSync(path, 'utf8'));
else {
  const contract = `bag-heist-${Date.now().toString(36)}.testnet`;
  saved = { network: 'testnet', contract_id: contract, rpc_url: rpcUrl, credentials: {}, transactions: [] };
  for (const role of ['contract', 'crewA', 'crewB', 'crewC']) saved.credentials[role] = { account_id: role === 'contract' ? contract : `${role.toLowerCase()}.${contract}`, ...newKeyPair() };
  writeFileSync(path, JSON.stringify(saved, null, 2), { mode: 0o600 });
}
const save = () => writeFileSync(path, JSON.stringify(saved, null, 2), { mode: 0o600 });
const contractKey = saved.credentials.contract;
if (saved.faucet_requested && saved.faucet_result?.status === 200) {
  for (let attempt = 0; attempt < 12 && !await near.accountExists(saved.contract_id); attempt++) await new Promise(resolve => setTimeout(resolve, 2000));
}
if (!await near.accountExists(saved.contract_id)) {
  if (saved.faucet_requested) throw new Error('Faucet already requested; inspect existing account/result before retry.');
  saved.faucet_requested = true; save();
  const response = await fetch('https://helper.nearprotocol.com/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: saved.contract_id, newAccountPublicKey: contractKey.publicKey }), signal: AbortSignal.timeout(30_000) });
  saved.faucet_result = { status: response.status, result: await response.text() }; save();
  if (!response.ok) throw new Error(`Faucet returned ${response.status}`);
  for (let attempt = 0; attempt < 12 && !await near.accountExists(saved.contract_id); attempt++) await new Promise(resolve => setTimeout(resolve, 2000));
}
const contract = near.account(saved.contract_id, contractKey.privateKey);
const wasm = readFileSync(new URL('../res/bag_heist.wasm', import.meta.url));
const account = await near.viewAccount(saved.contract_id);
if (account.code_hash !== codeHashOf(wasm)) {
  if (saved.deployment_attempted) throw new Error('Deployment already attempted; inspect saved transaction before retry.');
  saved.deployment_attempted = true; save();
  const outcome = summarizeOutcome(await deployAndInit(contract, wasm));
  saved.transactions.push({ method: 'deploy_and_initialize', ...outcome }); save();
  if (outcome.outcome !== 'success') throw new Error(`Deployment failed: ${outcome.error}`);
  console.log(`confirmed deployment ${outcome.tx_hash}`);
}
for (const role of ['crewA', 'crewB', 'crewC']) {
  const key = saved.credentials[role];
  if (!await near.accountExists(key.account_id)) {
    const outcome = summarizeOutcome(await createAccount(contract, key.account_id, 2n * NEAR, key.publicKey));
    saved.transactions.push({ method: 'create_account', ...outcome }); save();
    if (outcome.outcome !== 'success') throw new Error(`Account creation failed: ${outcome.error}`);
  }
}
const state = await near.view(saved.contract_id, 'get_state');
const keys = await near.rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: saved.contract_id });
mkdirSync(new URL('../public/evidence/', import.meta.url), { recursive: true });
writeFileSync(publicPath, JSON.stringify({ network: 'testnet', contract_id: saved.contract_id, rpc_url: rpcUrl, source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), code_hash: codeHashOf(wasm), deployed_at: new Date().toISOString(), keys: keys.keys, roles: Object.fromEntries(Object.entries(saved.credentials).map(([role, key]) => [role, { account_id: key.account_id, public_key: key.publicKey }])), transactions: saved.transactions, initial_state: state }, null, 2) + '\n');
console.log(`confirmed contract ${saved.contract_id}`);
console.log(`confirmed code ${codeHashOf(wasm)}`);
console.log(`confirmed supply ${state.total_supply}`);
