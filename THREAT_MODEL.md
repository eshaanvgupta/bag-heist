# Threat model

BAG HEIST assumes an adversary can read all public contract state and pending transactions, operate automated solvers, control multiple accounts, submit at phase boundaries, choose unreliable RPC providers, and induce users to lose local reveal data. It does not assume a trusted game server.

## Guarantees established by the design

**Route secrecy and replay boundaries.** A commitment contains a 32-byte random salt plus network, contract, player, round, board, crowbar setting, and route. Reveals cannot be accepted before commitment closes. A copied reveal from another account, round, contract, or board cannot match.

**Bounded execution.** Routes are at most 35 moves, rounds at most 64 participants, inventories at most 10 crowbars, and list endpoints are paginated and capped. Each reveal validates one bounded route and updates one best record. Finalization reads that record without scanning players.

**Economic isolation.** The fixed game budget is independent of arbitrary FT balances. Donations and temporarily unresolved `ft_transfer_call` funds cannot back a new prize. Reservations cannot be reused. Claims move balances without changing supply; crafting and expired pots burn exact amounts. Contract views expose the three accounting audits.

**Storage funding.** Profile, round, and commitment growth require retained deposits measured with margin. The commitment allocation reserves space for the maximum reveal record. Failed calls revert atomically.

**Authorization.** User methods use `predecessor_account_id`; prize claims require the winner; standard resolver callbacks use the standards implementation. Exact-one-yocto protection applies where balance-changing NEP-141/145 behavior requires it.

**Reveal recovery.** The browser saves route, salt, account, network, contract, round, board hash, crowbar flag, and commitment hash before opening the wallet. Drafts are keyed by that identity, retained across reloads/tabs, exportable, and revalidated against the connected wallet, board, and chain commitment before reveal.

## Explicit system boundaries

**Automated solvers.** Boards are deterministic and public. Solvers are legitimate participants and can outperform humans. Commit–reveal provides sealed submissions and account binding, not proof of personhood.

**Multiple accounts.** There is no Sybil resistance. Storage deposits and one commitment per account price state growth but do not establish unique humans.

**Transaction ordering.** Earlier commitment sequence is a final tie-break based on chain execution order. Wallet submission time, local time, or mempool observation does not guarantee that order.

**Timing and liveness.** The block timestamp is authoritative. A delayed wallet, congested network, unavailable RPC, or transaction included after a boundary can miss a phase. The UI labels its countdown advisory and refreshes after finality.

**Local secrets.** Loss of every reveal backup can make a valid commitment unrevealable. Anyone obtaining a backup can read the route and salt, but account binding prevents them from revealing it as themselves. Browser storage is not a hardware secret store.

**RPC and wallet trust.** A provider can be unavailable or return incorrect data. Board-hash reconstruction detects a central piece of inconsistent state; judges should cross-check public evidence through independent RPC/explorer sources. Wallet software and the user's device remain trusted signing components.

**Upgrade authority.** There is no privileged upgrade method in the contract. Any retained full-access key on the NEAR contract account can nevertheless deploy replacement code or delete the account. The real deployment must publish its keys and code hash. Key deletion requires an explicit account-holder decision.

The published account `bag-heist-mw7swkjh.testnet` retains the full-access key `ed25519:7WfeuwhLtS91NE4Lwi2fHcQgnPP9vK17HdK4mdK59w2i`. The private material is retained in ignored local operator credentials. `public/evidence/deployment.json` records this key, the on-chain code hash, and the three independent demonstration accounts.

**Service availability.** The hosted frontend may be unavailable while the on-chain interface remains usable. GitHub Pages, RPC services, wallets, and explorers are external services. Practice mode remains available from a built copy but is not chain evidence.

## Defensive test coverage

The contract suite covers exact time boundaries, early/repeated settlement, repeated claims, duplicate/full commitments, route failure classes, every ranking tie-break, matching-invalid and missing reveals, replay dimensions, reservations, standard transfers/refunds/unregistration, pending resolver funds, crowbar burns/consumption, full treasury exhaustion, and reproducible randomized sequences checked against an independent model. TypeScript asserts the shared board, commitment, named-route, and 704-route differential corpus. Browser tests cover route editing, recovery, mode safety, and responsive layout.
