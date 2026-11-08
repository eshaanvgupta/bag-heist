# BAG HEIST

**Every move has a price.** BAG HEIST is a playable, commit–reveal vault puzzle on NEAR testnet. Players route through a public 6×6 board, seal a solution, and reveal after the commitment window. The contract ranks every valid reveal and makes the best one a claimable 100 BAG prize. If nobody submits a valid reveal, that round's 100 BAG reserve is burned.

Hackathon tracks: **Memecoins With Mechanics** (`memecoins`, primary) and **Games With Real Economies** (`games`, secondary).

## Try it

Open **[BAG HEIST](https://eshaanvgupta.github.io/bag-heist/)**. Press **Start heist**, connect a NEAR testnet wallet, and join the live vault. The deployed contract is already configured; no account entry, local installation, or hosted game backend is needed. Use **Practice floor** for a wallet-free run whose clock begins when Start is pressed.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:4173`. The application opens in live testnet mode. Practice mode runs the complete loop with an accelerated local clock: Start → register → plan → commit → reveal → finalize → claim → burn BAG to craft a crowbar → consume it in a later commitment. Testnet mode uses wallet-signed transactions and chain-derived state. Evidence mode is read-only and never broadcasts.

Production build and checks:

```bash
pnpm test:unit       # TypeScript rules, recovery, and practice economy
pnpm test:rust       # 26 contract tests, including model-based sequences
pnpm test:sandbox    # compiled WASM on a local NEAR sandbox
pnpm test:browser    # desktop and mobile application flows
pnpm build           # reproducible contract + production frontend
pnpm verify:release  # artifact, source, and cross-language fixture integrity
```

Node `24.x`, pnpm `11.25.0`, Rust/Cargo `1.97.0`, `near-sdk = 5.30.1`, and `near-contract-standards = 5.30.1` are pinned. Both lockfiles are committed.

## What judges can inspect

- A unified Rust contract implementing the BAG fungible token and the game, so prize accounting settles atomically inside one contract.
- Fixed issuance of 1,000,000 BAG (6 decimals), 100 BAG round reserves, and 5 BAG crowbar burns.
- Exact phase boundaries from the block timestamp: 120 seconds to commit, then 120 seconds to reveal.
- Deterministic boards drawn from eight tested templates and eight geometric transforms. Every template has a non-crowbar route; door routes create optional trade-offs.
- Account-, contract-, round-, board-, route-, salt-, and crowbar-bound SHA-256 commitments.
- On-chain route validation and ranking: more loot, then fewer moves, then earlier commitment sequence.
- Constant-time finalization: the best valid submission is maintained during reveals.
- Independent game-budget, reservation, payout, expired-pot burn, crafting-burn, and total-supply counters with three contract-reported audit checks.
- Bounded routes, rounds, participants, inventory, pagination, and explicit deposits for every growing game record.
- Reveal backups saved before wallet approval, import/export validation, keyboard/touch play, reduced-motion styling, and an unmistakable mode indicator.
- Shared Rust/TypeScript fixtures: 28 board vectors, 10 commitment vectors, 19 named route cases, and 704 reproducible differential routes.

The compiled release is [`res/bag_heist.wasm`](res/bag_heist.wasm). Its reproducible build record is [`res/contract-build.json`](res/contract-build.json): 263,674 bytes, SHA-256 `1d5b89077475ceaaf69a2d25a939198a9608caae85e3803e563aa466cfef56d1`, WebAssembly MVP validated, 31 expected exports.

## Product architecture

The browser is a dynamic NEAR client; it needs no privileged application server. Practice mode uses the same TypeScript rules as the cross-language corpus. Live mode reads NEAR RPC state, submits through My NEAR Wallet via Wallet Selector, waits for a final transaction outcome, and refreshes chain state. Evidence mode renders only recorded public receipts that pass its schema checks. Missing evidence is shown as unavailable—not inferred.

The release can be served by GitHub Pages or any static asset host while all authoritative live state remains on NEAR. A production container and health check are included for commercial hosting.

## Contract economy

| Parameter | Fixed value |
|---|---:|
| Token | Bag Heist (`BAG`) |
| Initial supply | 1,000,000 BAG |
| Round prize | 100 BAG |
| Crowbar craft burn | 5 BAG |
| Commit / reveal | 120 s / 120 s |
| Board / route | 6×6 / at most 35 moves |
| Round participants | at most 64 |
| Crowbar inventory | at most 10 |
| Profile / round / commitment deposits | 0.005 / 0.02 / 0.02 NEAR |

The contract maintains:

```text
unallocated budget + reserved prizes + rewards paid + expired pots burned
= initial supply

contract BAG balance >= unallocated budget + reserved prizes

current supply + expired-pot burns + crafting burns + standard FT burns
= initial supply
```

Incoming transfers never increase the game allocation budget. A crowbar is consumed when a crowbar-enabled commitment succeeds, even if its owner later misses reveal or submits an invalid route.

## Documentation

- [`RULES.md`](RULES.md) — exact board, route, ranking, commitment, and accounting rules
- [`THREAT_MODEL.md`](THREAT_MODEL.md) — security boundaries and operational authority
- [`TESTNET.md`](TESTNET.md) — deployment and read-only evidence verification
- [`DEMO.md`](DEMO.md) — reproducible judge walkthrough and 75-second script
- [`ATTRIBUTIONS.md`](ATTRIBUTIONS.md) — dependency origins and licenses
- [`PRODUCTION.md`](PRODUCTION.md) — Pages and container deployment

## Independent-submission disclosure

BAG HEIST is an independent submission by Eshaan Gupta. The author's other independent NEAR Hackathon 2026 submission is [AEGIS // COUNTERFACTUAL](https://github.com/eshaanvgupta/aegis-counterfactual). The projects have separate repositories, contracts, frontends, deployments, state, mechanics, and demonstrations.

Reciprocal wording for AEGIS:

> Disclosure: The author has also submitted the independent project [BAG HEIST](https://github.com/eshaanvgupta/bag-heist) to NEAR Hackathon 2026. BAG HEIST has its own repository, contract, frontend, deployment, state, mechanics, and demonstration; neither submission depends on the other.

## Release status

The release is deployed on NEAR testnet at [`bag-heist-mw7swkjh.testnet`](https://testnet.nearblocks.io/address/bag-heist-mw7swkjh.testnet). Deployment and initialization settled atomically in [transaction FYpnEQBm6jKQp2pzMYkoGqPL84UdY5FbYfKgp1t8BXpz](https://testnet.nearblocks.io/txns/FYpnEQBm6jKQp2pzMYkoGqPL84UdY5FbYfKgp1t8BXpz). Its on-chain code hash is `2ybn6Uzughan9SHbLZ2XyANYuTq41LmNK5fSrimuGGDe`, matching the committed WASM. Public identities, account keys, and deployment receipts are in [`public/evidence/deployment.json`](public/evidence/deployment.json). The account retains one full-access deployment key; its authority is documented in `THREAT_MODEL.md`.

`pnpm verify:testnet` checks published game receipts and current contract audits through read-only RPC. A missing record or failed RPC produces `unavailable` and a non-zero exit; a receipt/code discrepancy produces `mismatching`. Wallet approval always belongs to the visiting player.

The recorded walkthrough contains **28 verified transactions across three live rounds**: two 100 BAG payouts, copied-reveal and repeated-claim rejections, a 5 BAG crafting burn, crowbar consumption and a valid door route, followed by a 100 BAG empty-round burn. Recorded final supply is **999,895 BAG**. See [`DEMO.md`](DEMO.md) for explorer links and [`public/evidence/testnet.json`](public/evidence/testnet.json) for the complete public receipt bundle.

MIT licensed. See [`LICENSE`](LICENSE).
