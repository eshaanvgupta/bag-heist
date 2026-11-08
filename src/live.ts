import type { WalletSelector, Wallet, BrowserWallet } from '@near-wallet-selector/core';
import type { Commitment, Config, Economy, Profile, Round, Snapshot } from './types';

export const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://test.rpc.fastnear.com';
const PENDING = 'bag-heist:pending:v1';
export interface PendingTransaction { contractId: string; accountId: string; method: string; hash?: string; createdAt: string }
export interface TransactionResult { status: 'confirmed' | 'failed' | 'pending' | 'unavailable'; hash: string; message: string }
export async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 14_000);
  try {
    const response = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }), signal: controller.signal });
    if (!response.ok) throw new Error(`RPC unavailable (${response.status}).`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.data || payload.error.message || 'RPC request failed.');
    return payload.result;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('RPC request timed out. Your saved reveal backup is safe.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function encodeArgs(args: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
}
export async function view<T>(contractId: string, method: string, args: object = {}, blockId?: string): Promise<{ value: T; blockHash: string }> {
  const result = await rpc('query', { request_type: 'call_function', ...(blockId ? { block_id: blockId } : { finality: 'final' }), account_id: contractId, method_name: method, args_base64: encodeArgs(args) });
  if (result.error) throw new Error(result.error);
  return { value: JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))), blockHash: result.block_hash };
}
export async function loadSnapshot(contractId: string, account: string | null, selectedRound?: string): Promise<Snapshot> {
  if (!/^[a-z0-9._-]+\.testnet$/.test(contractId) || contractId.length > 64) throw new Error('Enter the deployed BAG HEIST .testnet contract account.');
  const state = await view<Economy>(contractId, 'get_state');
  const config = (await view<Config>(contractId, 'get_config', {}, state.blockHash)).value;
  if (config.network !== 'near:testnet' && config.network !== 'testnet') throw new Error('Wrong network: BAG HEIST is configured for NEAR testnet.');
  if (config.contract_id !== contractId) throw new Error('Contract identity does not match its configuration.');
  const roundId = selectedRound || state.value.current_round_id;
  const count = BigInt(state.value.round_count), from = count > 20n ? String(count - 19n) : '1';
  const [round, rounds, profile, balance, registered, commitment, commitments] = await Promise.all([
    roundId ? view<Round | null>(contractId, 'get_round', { round_id: roundId }, state.blockHash).then(x => x.value) : null,
    view<Round[]>(contractId, 'get_rounds', { from_id: from, limit: 20 }, state.blockHash).then(x => x.value),
    account ? view<Profile | null>(contractId, 'get_profile', { account_id: account }, state.blockHash).then(x => x.value) : null,
    account ? view<string>(contractId, 'ft_balance_of', { account_id: account }, state.blockHash).then(x => x.value) : '0',
    account ? view<object | null>(contractId, 'storage_balance_of', { account_id: account }, state.blockHash).then(x => x.value) : null,
    account && roundId ? view<Commitment | null>(contractId, 'get_commitment', { round_id: roundId, account_id: account }, state.blockHash).then(x => x.value) : null,
    roundId ? view<Commitment[]>(contractId, 'get_commitments', { round_id: roundId, from_sequence: 1, limit: 64 }, state.blockHash).then(x => x.value) : [],
  ]);
  return { config, economy: state.value, round, rounds: rounds.sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1), profile, balance, ftRegistered: !!registered, account, commitment, commitments, receivedAt: Date.now() };
}
let selectorPromise: Promise<WalletSelector> | undefined;
export function selector(): Promise<WalletSelector> {
  selectorPromise ??= Promise.all([import('@near-wallet-selector/core'), import('@near-wallet-selector/my-near-wallet')]).then(([core, wallet]) => core.setupWalletSelector({ network: { networkId: 'testnet', nodeUrl: RPC_URL, helperUrl: 'https://helper.nearprotocol.com', explorerUrl: 'https://testnet.nearblocks.io', indexerUrl: 'https://api-testnet.nearblocks.io' }, modules: [wallet.setupMyNearWallet({ walletUrl: 'https://testnet.mynearwallet.com' })] }));
  return selectorPromise;
}
export async function currentAccount(): Promise<string | null> {
  return (await selector()).store.getState().accounts.find(account => account.active)?.accountId ?? null;
}
export async function connectWallet(contractId: string): Promise<string | null> {
  const client = await selector(), wallet = await client.wallet('my-near-wallet');
  const returnUrl = new URL(window.location.href);
  returnUrl.search = '';
  returnUrl.hash = '';
  await (wallet as BrowserWallet).signIn({ contractId, successUrl: returnUrl.href, failureUrl: returnUrl.href });
  return currentAccount();
}
export async function disconnectWallet() {
  const client = await selector();
  if (client.isSignedIn()) await (await client.wallet()).signOut();
}
export function pendingTransaction(): PendingTransaction | null {
  try { const result = JSON.parse(localStorage.getItem(PENDING) || 'null'); return result?.contractId && result?.accountId ? result : null; }
  catch { return null; }
}
export function clearPending() { localStorage.removeItem(PENDING); }
export async function transactionStatus(hash: string, accountId: string): Promise<TransactionResult> {
  try {
    const tx = await rpc('tx', { tx_hash: hash, sender_account_id: accountId, wait_until: 'FINAL' });
    if (tx.final_execution_status && tx.final_execution_status !== 'FINAL') return { status: 'pending', hash, message: 'Waiting for finality. Refresh to check again.' };
    const failures = [tx.status, ...(tx.receipts_outcome ?? []).map((receipt: any) => receipt.outcome?.status)].filter(status => status && typeof status === 'object' && 'Failure' in status);
    if (failures.length) return { status: 'failed', hash, message: JSON.stringify(failures[0].Failure).slice(0, 360) };
    if (tx.status && typeof tx.status === 'object' && ('SuccessValue' in tx.status || 'SuccessReceiptId' in tx.status)) return { status: 'confirmed', hash, message: 'Transaction finalized on NEAR testnet. State refreshed from the chain.' };
    return { status: 'pending', hash, message: 'Transaction has not produced a final result yet.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: /UNKNOWN_TRANSACTION|doesn't exist|not found/i.test(message) ? 'pending' : 'unavailable', hash, message: `Verification unavailable: ${message}. Refresh to retry; do not resubmit a pending transaction.` };
  }
}
export async function sendTransaction(input: { contractId: string; accountId: string; method: string; args?: object; deposit?: string }, onPending: (hash?: string) => void): Promise<TransactionResult | null> {
  const client = await selector();
  const account = await currentAccount();
  if (account !== input.accountId) throw new Error('Your wallet changed. Refresh the account before signing.');
  const wallet: Wallet = await client.wallet();
  const pending: PendingTransaction = { contractId: input.contractId, accountId: account, method: input.method, createdAt: new Date().toISOString() };
  localStorage.setItem(PENDING, JSON.stringify(pending));
  let result;
  try {
    result = await wallet.signAndSendTransaction({ receiverId: input.contractId, actions: [{ type: 'FunctionCall', params: { methodName: input.method, args: input.args ?? {}, gas: '100000000000000', deposit: input.deposit ?? '0' } } as any] });
  } catch (error) { clearPending(); throw error; }
  const hash = (result as any)?.transaction?.hash;
  if (!hash) { onPending(); return null; }
  pending.hash = hash; localStorage.setItem(PENDING, JSON.stringify(pending)); onPending(hash);
  let status = await transactionStatus(hash, account);
  for (let attempt = 0; attempt < 8 && status.status === 'pending'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1500)); status = await transactionStatus(hash, account);
  }
  if (status.status === 'confirmed' || status.status === 'failed') clearPending();
  return status;
}
