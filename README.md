# btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/overtheraadot/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/overtheraadot/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A shallow-dip ladder mean-reversion bot trading cbBTC/USDC on 1-minute bars.

## Strategy

On this pool the 1-minute noise is tiny (a few bps per bar) but the price
keeps dipping 50–150 bps below its recent high and then bouncing part-way
back. The bot buys those dips in scaled tranches and sells the bounce:

- **Entry:** close ≥ 60 bps below the rolling 30-bar high of closes → buy
  25% of equity. A deeper dip (≥ 100 bps) adds another 25%, and ≥ 140 bps
  adds a final 25% (max 75% deployed).
- **Exit:** sell everything when the close is ≥ 60 bps above the
  volume-weighted average fill price, or ≥ 250 bps below it (hard stop),
  or the position has been held 120 bars, or bar 1380 is reached (never
  leave a position to the forced flatten at the end of the window).
- **Pacing:** 30-bar cooldown after each full exit, at most 12 round trips,
  no new entries after bar 1200.

## Implementation

- `main.ts` — the bot, written against the kit's `vendor/makefun-bars.ts`
  shim (copied byte-for-byte from the kit SDK). All price comparisons are
  exact `BigInt` arithmetic in the bars' raw integer units; sizing uses
  integer micro-USDC.
- Deterministic: decisions depend only on the bars and fills the harness
  sends — no wall clock, no randomness, no environment, no network.

## Local grade

From the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8bg6hn2r&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
