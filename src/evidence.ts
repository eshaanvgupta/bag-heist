import build from '../res/contract-build.json';
import vectors from '../fixtures/vectors.json';

export interface TestnetTransaction {
  hash: string;
  signer_id: string;
  method: string;
  outcome: 'success' | 'failure';
  explorer_url: string;
  logs: string[];
  supply_before?: string;
  supply_after?: string;
}

export interface TestnetEvidence {
  schema: 'bag-heist-testnet-evidence-v1';
  network: 'testnet';
  contract_id: string;
  code_hash: string;
  wasm_sha256: string;
  source_commit: string;
  verified_at: string;
  transactions: TestnetTransaction[];
}

export const releaseEvidence = {
  wasm: build,
  boards: vectors.boards.length,
  commitments: vectors.commitments.length,
  namedRoutes: vectors.routes.length,
  differentialRoutes: vectors.differential.length,
};

function assertEvidence(value: unknown): TestnetEvidence {
  if (!value || typeof value !== 'object') throw new Error('Evidence file is not an object.');
  const evidence = value as TestnetEvidence;
  if (evidence.schema !== 'bag-heist-testnet-evidence-v1' || evidence.network !== 'testnet') throw new Error('Evidence schema or network does not match BAG HEIST testnet.');
  if (!/^[a-z0-9._-]+\.testnet$/.test(evidence.contract_id) || !/^[0-9a-f]{64}$/.test(evidence.wasm_sha256) || !Array.isArray(evidence.transactions)) throw new Error('Evidence identity is malformed.');
  for (const transaction of evidence.transactions) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(transaction.hash) || !['success', 'failure'].includes(transaction.outcome)) throw new Error('Evidence contains a malformed transaction record.');
  }
  return evidence;
}

export async function loadTestnetEvidence(): Promise<TestnetEvidence | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}evidence/testnet.json`, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Evidence endpoint returned ${response.status}.`);
    return assertEvidence(await response.json());
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Evidence file is not valid JSON.');
    throw error;
  }
}
