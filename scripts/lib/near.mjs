/**
 * Minimal NEAR client shared by the sandbox suite, the testnet scripts and the
 * evidence verifier. Views and status queries are plain JSON-RPC; signing uses
 * near-api-js. Nothing here reads key material from disk.
 */
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, PublicKey, actions } from 'near-api-js';

export const TGAS = 1_000_000_000_000n;
export const NEAR = 10n ** 24n;
export const DEPOSITS = {
  profile: 5_000_000_000_000_000_000_000n,
  round: 20_000_000_000_000_000_000_000n,
  commitment: 20_000_000_000_000_000_000_000n,
  ftStorage: 1_250_000_000_000_000_000_000n,
};

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}
export const sha256 = (data) => createHash('sha256').update(data).digest();
/** NEAR's code hash is base58(sha256(code)). */
export const codeHashOf = (code) => base58(sha256(code));

export class RpcUnavailable extends Error {}

export class Near {
  constructor(rpcUrl, { timeoutMs = 20_000 } = {}) {
    this.rpcUrl = rpcUrl;
    this.timeoutMs = timeoutMs;
    this.provider = new JsonRpcProvider({ url: rpcUrl }, { retries: 3, wait: 500, backoff: 2 });
  }

  async rpc(method, params) {
    let response;
    try {
      response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'bag-heist', method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RpcUnavailable(`${method}: ${error.message}`);
    }
    if (!response.ok) throw new RpcUnavailable(`${method}: HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) {
      const error = new Error(payload.error.data ? JSON.stringify(payload.error.data) : payload.error.message);
      error.rpc = payload.error;
      throw error;
    }
    return payload.result;
  }

  status() {
    return this.rpc('status', []);
  }

  finalBlock() {
    return this.rpc('block', { finality: 'final' });
  }

  async view(contractId, method, args = {}, blockId) {
    const result = await this.rpc('query', {
      request_type: 'call_function',
      ...(blockId ? { block_id: blockId } : { finality: 'final' }),
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    if (result.error) throw new Error(result.error);
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
  }

  async viewAccount(accountId) {
    return this.rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
  }

  async accountExists(accountId) {
    try {
      await this.viewAccount(accountId);
      return true;
    } catch (error) {
      if (error instanceof RpcUnavailable) throw error;
      if (/UNKNOWN_ACCOUNT|does not exist/i.test(error.message)) return false;
      throw error;
    }
  }

  /** Transaction status with receipts, waiting for finality. */
  txStatus(hash, senderId, waitUntil = 'FINAL') {
    return this.rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: senderId, wait_until: waitUntil });
  }

  account(accountId, privateKey) {
    return new Account(accountId, this.provider, privateKey);
  }
}

/** Flatten a final execution outcome into the fields recorded as evidence. */
export function summarizeOutcome(result) {
  const receipts = result.receipts_outcome ?? [];
  const logs = receipts.flatMap((r) => r.outcome.logs);
  const failure = [result.status, ...receipts.map((r) => r.outcome.status)].find((s) => s && typeof s === 'object' && 'Failure' in s);
  const message = failure ? JSON.stringify(failure.Failure) : null;
  const panic = message?.match(/panicked: ([^"\\]+)/)?.[1] ?? message?.match(/"(?:ExecutionError|FunctionCallError)":"([^"]+)"/)?.[1] ?? null;
  let returnValue = null;
  if (!failure && result.status && typeof result.status === 'object' && 'SuccessValue' in result.status && result.status.SuccessValue) {
    const text = Buffer.from(result.status.SuccessValue, 'base64').toString('utf8');
    try {
      returnValue = JSON.parse(text);
    } catch {
      returnValue = text;
    }
  }
  return {
    tx_hash: result.transaction?.hash ?? result.transaction_outcome?.id,
    signer_id: result.transaction?.signer_id,
    receiver_id: result.transaction?.receiver_id,
    outcome: failure ? 'failure' : 'success',
    error: panic ?? (failure ? message.slice(0, 300) : null),
    logs,
    events: logs.filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice('EVENT_JSON:'.length))),
    gas_burnt: String(receipts.reduce((sum, r) => sum + BigInt(r.outcome.gas_burnt), BigInt(result.transaction_outcome?.outcome?.gas_burnt ?? 0))),
    first_receipt_block: receipts[0]?.block_hash ?? result.transaction_outcome?.block_hash,
    return_value: returnValue,
  };
}

export async function callContract(account, contractId, method, args = {}, { deposit = 0n, gas = 100n * TGAS } = {}) {
  const result = await account.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, args, gas, BigInt(deposit))],
    waitUntil: 'FINAL',
    throwOnFailure: false,
  });
  return result;
}

/** Create `newId` from `creator`, fund it and add a full-access key. */
export async function createAccount(creator, newId, amount, publicKey) {
  return creator.signAndSendTransaction({
    receiverId: newId,
    actions: [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(PublicKey.fromString(publicKey))],
    waitUntil: 'FINAL',
    throwOnFailure: false,
  });
}

/** Deploy and initialize in one transaction, so nobody can front-run `new`. */
export async function deployAndInit(contractAccount, code) {
  return contractAccount.signAndSendTransaction({
    receiverId: contractAccount.accountId,
    actions: [actions.deployContract(new Uint8Array(code)), actions.functionCall('new', {}, 100n * TGAS, 0n)],
    waitUntil: 'FINAL',
    throwOnFailure: false,
  });
}

export function newKeyPair() {
  const pair = KeyPair.fromRandom('ed25519');
  return { publicKey: pair.getPublicKey().toString(), privateKey: pair.toString() };
}

export const yoctoToNear = (yocto) => {
  const value = BigInt(yocto);
  const whole = value / NEAR;
  const fraction = (value % NEAR).toString().padStart(24, '0').slice(0, 4).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
};
