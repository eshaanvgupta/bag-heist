# Judge demonstration

## Reproducible walkthrough

Start with `pnpm dev`. Keep the **Practice floor** label visible whenever using its accelerated clock; it demonstrates the product flow and never presents local events as chain receipts.

1. Register the practice profile and BAG storage.
2. Draw a route with the board, keyboard, or touch controls. Show loot, length, doors, validity, and the locally recomputed board hash.
3. Select **Scout route**, then **Seal this route**. Show the saved commitment hash and exportable reveal backup.
4. Close the commitment window and reveal. Show the contract-compatible score and best-valid-submission ordering.
5. Close reveal, finalize, and claim exactly 100 BAG.
6. Craft a crowbar. Show balance and total supply each fall by exactly 5 BAG.
7. Open a later vault, select a door route, and explain that the crowbar is consumed when the commitment succeeds—even if reveal is missed.
8. Finalize a round with zero valid reveals. Show the reserved 100 BAG move to expired-pot burns and leave total supply.
9. Open **Evidence room**. Show the reproducible WASM hash, fixture corpus, and validated public testnet record.

For the recorded testnet version, use two legitimate players and a third account for the copied reveal attempt. Observe the real 120-second windows; video cuts must be labelled with the before/after block timestamps.

## 75-second video script

**0:00–0:08 — Decision.** “BAG HEIST turns a meme token treasury into a public vault. Every round escrows 100 BAG; the best valid route wins it, or the pot burns.”

**0:08–0:20 — Play.** Draw across the 6×6 vault. “Loot wins first, then route length, then commitment order. A crafted crowbar opens one door, but carrying it consumes it at commitment.”

**0:20–0:32 — Seal.** Commit from player one and a different route from player two. “The hash binds account, contract, round, board, crowbar, route, and a 256-bit browser salt. The reveal backup is saved before signing.”

**0:32–0:43 — Copy fails.** Show the third account's copied reveal failing, then the legitimate reveals scoring. “A public route is useless to a copier because player identity is inside the preimage.”

**0:43–0:55 — Settle.** Finalize and claim. “The contract maintained the best submission during reveal, so settlement is constant-time. Exactly 100 BAG moves from reserved treasury to the winner.”

**0:55–1:05 — Supply mechanic.** Craft a crowbar. “Five earned BAG burns, total supply falls, and the tool becomes inspectable inventory for a later raid.”

**1:05–1:15 — Audit.** Show a zero-valid-reveal finalization and Evidence room. “That unclaimed 100 BAG reserve burns. The UI reports budget identity, treasury coverage, and the full supply audit directly from contract state.”

## Expected outcomes

- Copied reveal: failed transaction or hash mismatch; no commitment mutation.
- Winner claim: balance `+100,000,000` atomic units; reservation `−100,000,000`; total supply unchanged.
- Crowbar craft: caller and total supply `−5,000,000`; crafting-burn counter `+5,000,000`.
- Empty round: treasury and total supply `−100,000,000`; reserved prize `−100,000,000`; expired-pot-burn counter `+100,000,000`.
- Second claim/finalization: rejected without changing state.
