# BAG HEIST rules and canonical encodings

This document is normative for the hackathon release. Contract constants returned by `get_config()` are the runtime authority.

## Board generation

Tile indices are row-major `0..35` on a 6×6 board. A board stores one start, one exit, 36 tile kinds (`0` open, `1` wall, `2` locked door), and 36 integer loot values (`0..9`). Start and exit differ and are not walls.

For contract account `c` and unsigned round id `r`:

```text
seed = SHA-256("BAG_HEIST_GENERATE_V1\0" || LP16(c) || u64_le(r))
template_index = seed[0] mod 8
transform_index = seed[1] mod 8
```

The selected template is transformed by one of the eight square symmetries. Start, exit, tile kinds, and loot move together. The eight source templates are code constants and fixture-backed. Each has at least one valid route without a crowbar and optional door topology.

### Canonical board hash

The exact byte sequence is:

```text
ASCII("BAG_HEIST_BOARD_V1") || 0x00
|| u8(6)
|| u8(start)
|| u8(exit)
|| for i = 0..35: u8(tile_kind[i]) || u8(loot[i])
```

It is 94 bytes: 19 domain bytes, 3 header bytes, and 72 interleaved cell bytes. `board_hash` is the lowercase hexadecimal SHA-256 digest. The browser reconstructs this value and disables commitment on mismatch.

## Route validity and ranking

Routes contain only uppercase ASCII `U`, `D`, `L`, `R` and at most 35 moves. Execution begins on start; its loot counts once. Each move must remain in the grid, horizontal movement cannot wrap, walls cannot be entered, and no tile—including start—may be revisited. The route must finish on exit and may not continue after first reaching it.

Without a crowbar, doors are blocked. With a crowbar, at most one door may be entered. Loot on every visited tile is added exactly once with checked integer arithmetic.

A matching reveal is valid only when all route rules hold. The best valid submitted route is ranked by:

1. greater total loot;
2. fewer moves;
3. earlier monotonically assigned commitment sequence.

The contract maintains the best candidate during reveals, making `finalize_round` constant-time.

## Commitment

`LP16(s)` is the UTF-8 byte length of `s` as unsigned 16-bit little-endian, followed by those UTF-8 bytes. The exact preimage is:

```text
ASCII("BAG_HEIST_COMMIT_V1") || 0x00
|| LP16("near:testnet")
|| LP16(contract_account_id)
|| LP16(player_account_id)
|| u64_le(round_id)
|| raw_32_byte_board_hash
|| u8(use_crowbar ? 1 : 0)
|| LP16(moves)
|| raw_32_byte_salt
```

`commitment_hash` is lowercase hexadecimal SHA-256. The contract supplies the network domain, its own account, caller identity, stored round id, stored board hash, and recorded crowbar setting. A reveal copied from another account therefore cannot match that account's commitment. Fixtures vary player, round, contract/board context, crowbar flag, route, and salt.

## Phase and settlement rules

- `open_round`: permissionless after the preceding round is finalized; reserves exactly 100 BAG from unallocated game budget.
- `commit_solution`: accepted only while `now < commitment_end`; one per registered profile, at most 64 participants. A selected crowbar is consumed atomically with a successful commitment.
- `reveal_solution`: accepted while `commitment_end <= now < reveal_end`. Hash mismatch changes nothing. A matching invalid reveal records its final reason; each commitment gets at most one matching reveal.
- `finalize_round`: permissionless when `now >= reveal_end`, exactly once. A winning route creates a claimable prize. Zero valid reveals burns the reserved 100 BAG.
- `claim_reward`: winner only, exactly once, and requires NEP-145 FT registration. The reservation remains intact if registration must be restored.
- `craft_crowbar`: registered profile, FT balance of at least 5 BAG, one yoctoNEAR, and inventory below 10. Exactly 5 BAG is burned; prize-budget accounting is unchanged.

Timestamps are immutable nanoseconds established when a round opens. Browser countdowns are advisory.

## Storage and bounded work

Profile registration retains 0.005 NEAR. Opening a round and creating a commitment each retain 0.02 NEAR. The constants cover measured maximum state growth with margin, including the largest reveal result. Public list queries are capped and paginated. Boards, moves, salts, participants, and inventory are bounded.

## Token accounting

BAG uses NEP-141 core/resolver behavior, NEP-145 storage management, and NEP-148 metadata from `near-contract-standards`. The fixed initial supply is issued once to the contract treasury during `new()`.

Game accounting moves only through unallocated → reserved → paid or expired-burned. Token donations and unresolved `ft_transfer_call` balances never create game budget. Standard forced-unregistration/resolver burns are counted separately so the complete supply audit remains exact.

## Participation model

Boards are public deterministic puzzles. Automated solvers and multiple accounts can participate. Commit–reveal protects a sealed route until reveal and binds it to one account; it is not proof of human identity and does not promise transaction ordering beyond chain execution.
