import { boardHash, commitmentHash } from './engine/rules';
import type { Board } from './engine/rules';

export interface RevealDraft {
  version: 1; network: 'near:testnet'; contractId: string; playerId: string; roundId: string;
  boardHash: string; commitmentHash: string; useCrowbar: boolean; moves: string; salt: string; savedAt: string;
}
const PREFIX = 'bag-heist:reveal:v1:';
const hex = /^[0-9a-f]{64}$/;
export const draftKey = (draft: RevealDraft) => PREFIX + [draft.network, draft.contractId, draft.roundId, draft.playerId, draft.commitmentHash].map(encodeURIComponent).join(':');
export function randomSalt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
}
export function makeDraft(input: Omit<RevealDraft, 'version' | 'network' | 'salt' | 'commitmentHash' | 'savedAt'>): RevealDraft {
  const draft = { ...input, version: 1 as const, network: 'near:testnet' as const, salt: randomSalt(), savedAt: new Date().toISOString() };
  return { ...draft, commitmentHash: commitmentHash(draft) };
}
export function validateDraft(value: unknown): RevealDraft {
  if (!value || typeof value !== 'object') throw new Error('This file is not a BAG HEIST reveal backup.');
  const d = value as RevealDraft;
  if (d.version !== 1 || d.network !== 'near:testnet' || typeof d.contractId !== 'string' || typeof d.playerId !== 'string' || d.contractId.length > 64 || d.playerId.length > 64 || !/^[a-z0-9._-]{2,64}$/.test(d.contractId) || !/^[a-z0-9._-]{2,64}$/.test(d.playerId)) throw new Error('Unsupported backup or account identity.');
  if (typeof d.roundId !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(d.roundId) || BigInt(d.roundId) > 18446744073709551615n) throw new Error('Invalid round in backup.');
  if (typeof d.moves !== 'string' || d.moves.length > 35 || !/^[UDLR]*$/.test(d.moves) || typeof d.useCrowbar !== 'boolean' || !hex.test(d.salt) || !hex.test(d.boardHash) || !hex.test(d.commitmentHash)) throw new Error('Malformed route, salt, board, or commitment hash.');
  if (commitmentHash(d) !== d.commitmentHash) throw new Error('Backup integrity check failed: its commitment hash does not match.');
  return d;
}
export function verifyDraftContext(draft: RevealDraft, context: { contractId: string; playerId: string; roundId: string; board: Board; commitmentHash: string }): void {
  validateDraft(draft);
  if (draft.playerId !== context.playerId) throw new Error('Wrong wallet: this backup belongs to another player.');
  if (draft.contractId !== context.contractId || draft.roundId !== context.roundId) throw new Error('This backup belongs to another contract or round.');
  if (draft.boardHash !== boardHash(context.board)) throw new Error('This backup does not match the immutable round board.');
  if (draft.commitmentHash !== context.commitmentHash) throw new Error('This backup does not match your recorded chain commitment.');
}
export function saveDraft(draft: RevealDraft, storage: Storage = localStorage): void {
  validateDraft(draft);
  const key = draftKey(draft), serialized = JSON.stringify(draft);
  const existing = storage.getItem(key);
  if (existing && validateDraft(JSON.parse(existing)).commitmentHash !== draft.commitmentHash) throw new Error('An existing reveal backup conflicts with this draft.');
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error('Could not safely save the reveal backup. Export a backup before continuing.');
}
export function findDrafts(context: { contractId: string; playerId: string; roundId: string }, storage: Storage = localStorage): RevealDraft[] {
  const results: RevealDraft[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const draft = validateDraft(JSON.parse(storage.getItem(key)!));
      if (draft.contractId === context.contractId && draft.playerId === context.playerId && draft.roundId === context.roundId) results.push(draft);
    } catch { /* A damaged unrelated draft must not erase healthy backups. */ }
  }
  return results.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
export function importBackup(text: string, context: Parameters<typeof verifyDraftContext>[1], storage: Storage = localStorage): RevealDraft {
  if (text.length > 4096) throw new Error('Reveal backup is too large.');
  const draft = validateDraft(JSON.parse(text));
  verifyDraftContext(draft, context);
  saveDraft(draft, storage);
  return draft;
}
