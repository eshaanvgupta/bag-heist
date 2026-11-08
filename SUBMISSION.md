# Submission copy

## Project name

BAG HEIST

## Tracks

Primary: Memecoins With Mechanics (`memecoins`)  
Secondary: Games With Real Economies (`games`)

## What did you build?

BAG HEIST is a competitive 6×6 heist puzzle where every round places 100 BAG from a fixed treasury at risk. Players privately commit account-bound route hashes, reveal after the commitment window, and let the Rust contract validate and rank the submitted routes by loot, efficiency, and commitment order. The best valid submission earns a claimable 100 BAG; if no valid reveal arrives, the reserved pot is burned. Winners can burn 5 BAG to craft an inspectable consumable crowbar that unlocks one door in a later raid and is consumed when its commitment succeeds.

The token and game share one NEAR contract, so reservations, payouts, crafting burns, and expired-pot burns settle atomically and remain auditable through contract views. The responsive application includes an accelerated but clearly labelled practice flow, wallet-signed testnet mode, and read-only evidence replay. It verifies board hashes in the browser, preserves sealed-route inputs as exportable reveal backups before wallet approval, and displays supply, burns, reserves, balance, inventory, phase, route score, and accounting invariants in one playable interface.

## Short pitch

A meme coin treasury you can rob—with skill, sealed bids, and consequences for supply.

## Independent-submission disclosure

The author has also submitted the independent project AEGIS // COUNTERFACTUAL. BAG HEIST has its own repository, contract, frontend, deployment, state, mechanics, and demonstration; neither submission depends on the other.
