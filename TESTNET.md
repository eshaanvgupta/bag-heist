# Testnet deployment and evidence

This guide separates release verification from chain evidence. It never treats a local simulation, planned account, or placeholder hash as a testnet transaction.

## Published deployment

The GitHub Pages application connects directly to `bag-heist-mw7swkjh.testnet` by default. Its code hash is `2ybn6Uzughan9SHbLZ2XyANYuTq41LmNK5fSrimuGGDe`. The deployment/initialization transaction is `FYpnEQBm6jKQp2pzMYkoGqPL84UdY5FbYfKgp1t8BXpz`. See `public/evidence/deployment.json` for the public full-access key and demo player roles. Credentials are stored only in ignored `runtime/deployment-credentials.json` on the operator's machine.

Live rounds are shared by all players and keep running according to chain time. Start enters the board; it never resets an existing live round. A fresh practice round is created only when its user presses Start.

## Prepare

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:sandbox
pnpm test:browser
pnpm verify:release
pnpm testnet:prepare
```

`testnet:prepare` checks the compiled artifact and testnet RPC, then prints the exact deployment plan. The release artifact is `res/bag_heist.wasm`; compare its SHA-256 with `res/contract-build.json` before signing.

For an independent deployment, set public identities without committing credentials:

```bash
NEAR_NETWORK=testnet
NEAR_CONTRACT_ID=<new-account>.testnet
NEAR_DEPLOYER=<authorized-account>.testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
```

Credentials belong in the NEAR CLI keychain or ignored runtime files. The repository contains no private key.

## Authorized deployment

The included `pnpm testnet:deploy` script provisions a dedicated account through NEAR's official free testnet faucet, stores credentials under ignored `runtime/`, deploys and initializes atomically, creates three independent demo accounts, and records public deployment evidence. It reuses its existing local identity on repeat runs and checks prior attempts before issuing transactions.

`pnpm demo:testnet:record` executes the real three-round walkthrough against those accounts and saves every completed step before proceeding. It waits for chain timestamps without shortening the deployed windows. `pnpm demo:testnet` prints the saved public receipt set.

Using current `near-cli-rs` syntax:

```bash
near contract deploy "$NEAR_CONTRACT_ID" \
  use-file res/bag_heist.wasm \
  without-init-call \
  network-config testnet \
  sign-with-keychain send

near contract call-function as-transaction "$NEAR_CONTRACT_ID" new \
  json-args '{}' \
  prepaid-gas '30 Tgas' \
  attached-deposit '0 NEAR' \
  network-config testnet \
  sign-with-keychain send
```

`new()` is private, can run once, and mints the fixed supply to the contract account. Immediately record the deployment transaction, initialization transaction, on-chain code hash, full-access keys, source commit, and artifact hash.

## Application configuration

```bash
VITE_NEAR_CONTRACT_ID="$NEAR_CONTRACT_ID" pnpm dev:testnet
```

The contract field remains editable so judges can independently point the client at the published account. My NEAR Wallet signs transactions. The application re-queries final chain state rather than assuming a wallet redirect means success.

## Evidence record

After real transactions, create ignored `runtime/testnet-evidence.json`, verify it, and copy the verified public record to `public/evidence/testnet.json` for Evidence mode. The schema requires:

- network and contract id;
- source commit, WASM SHA-256, and on-chain code hash;
- verification timestamp;
- transaction hash, signer, method, final outcome, explorer URL, and logs;
- supply before/after for economic events.

```bash
pnpm verify:testnet
```

The verifier performs read-only RPC calls and prints one of `confirmed`, `failed`, `pending`, `unavailable`, or `mismatching` for each record. RPC failure and missing evidence are `unavailable` and produce a non-zero exit status. A hash, code, receipt, method, or state discrepancy is `mismatching` and also fails.

## Roles and upgrade authority

The contract has no in-contract owner method, mint method, parameter setter, or upgrade method. A full-access key on the contract account can still replace code or delete the account; that is NEAR account authority outside the WASM interface. Publish the actual keys/roles with the deployment evidence. Removing any key is a separate authorized operational act and is not implied by this repository.

## Demonstration receipt set

Record at least: deployment, initialization, two profile/FT registrations, two commitments, copied-reveal failure, two matching reveals, finalization, 100 BAG claim, failed second claim, 5 BAG crowbar craft/burn, later crowbar consumption, and a zero-valid-reveal 100 BAG burn. Capture before/after `get_state`, `ft_total_supply`, relevant balances, round, profile, commitment, and crowbar views.
