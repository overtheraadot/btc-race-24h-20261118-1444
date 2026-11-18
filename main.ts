// btc-race-24h-20261118-1444 — Account A (overtheraa)
// Shallow-dip ladder mean-reversion bot for cbBTC/USDC, 1-minute bars.
//
// Idea: on this pool the 1-minute noise is tiny (a few bps per bar) but the
// price keeps dipping 50-150 bps below its recent high and then bouncing
// part-way back. The bot buys those dips in scaled tranches and sells the
// bounce, never chasing a falling price with its whole stack at once.
//
//   entry  : close >= 55 bps below the rolling 30-bar high of closes
//            -> buy 33% of equity; a deeper dip (>= 95 bps) adds 33%,
//            and >= 135 bps adds a final 34% (max 100% deployed).
//   exit   : sell everything when the close is >= 60 bps above the
//            volume-weighted average fill price, or >= 250 bps below it
//            (hard stop), or the position has been held 120 bars, or
//            bar 1380 is reached (never leave a position to the forced
//            flatten at the end of the window).
//   pacing : 30-bar cooldown after each full exit, at most 12 round
//            trips, no new entries after bar 1200.
//
// Everything is computed from the bars the harness sends (no wall clock,
// no randomness, no environment), so two runs on the same data decide
// the same orders. All price comparisons are exact BigInt arithmetic in
// the bar's raw integer units; sizing uses integer micro-USDC.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tunables (bps unless noted) -------------------------------------------
const HIGH_WINDOW = 30; // bars of closes forming the rolling high
const DIP_LEVELS_BPS = [55, 95, 135]; // ladder rungs, below rolling high
const TRANCHE_BPS = [3300, 3300, 3400]; // each tranche's share of equity, in bps
const TAKE_PROFIT_BPS = 60; // sell all when close >= avg fill + 60 bps
const HARD_STOP_BPS = 250; // sell all when close <= avg fill - 250 bps
const MAX_HOLD_BARS = 120; // sell all after 120 bars in a position
const COOLDOWN_BARS = 30; // bars to wait after a full exit before re-entering
const MAX_ROUND_TRIPS = 12; // cap on completed round trips per window
const NO_ENTRY_AFTER_BAR = 1200; // no new positions in the last 240 bars
const FORCE_EXIT_BAR = 1380; // flatten any open position by this bar
const MAX_SLIPPAGE_BPS = 100; // cap the fill's move from the latest close
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in micro-USDC

const BPS = 10_000n;

// --- per-run state, rebuilt from the fills the harness reports -------------
const closes: bigint[] = []; // every CBBTC close seen, in order
let lastBarT = -1; // t of the latest CBBTC bar folded in
let fillPriceQty = 0n; // sum of (fill price * qty) over open-position buys
let fillQty = 0n; // sum of qty over open-position buys
let buyFillCount = 0; // buy fills received for the open position
let entryBar = -1; // seq of the batch whose fill opened this position
let roundTrips = 0; // completed round trips this run
let lastExitSeq = -1_000_000; // seq of the batch whose fill closed a position

function avgFillPrice(): bigint | null {
  return fillQty > 0n ? fillPriceQty / fillQty : null;
}

function rollingHigh(): bigint | null {
  if (closes.length < HIGH_WINDOW) return null;
  let high = 0n;
  for (let i = closes.length - HIGH_WINDOW; i < closes.length; i++) {
    if (closes[i]! > high) high = closes[i]!;
  }
  return high;
}

/** Dip of the latest close below the rolling high, in bps (0 when none). */
function dipBps(): bigint {
  const high = rollingHigh();
  const close = closes[closes.length - 1];
  if (high === null || close === undefined || close <= 0n) return 0n;
  if (high <= close) return 0n;
  return ((high - close) * BPS) / close;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold in this batch's CBBTC bar (a batch may carry no bar for it).
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined && bar.t !== lastBarT) {
      lastBarT = bar.t;
      closes.push(BigInt(bar.c));
    }

    // Fold in the fills of the orders decided on the previous batch.
    // A buy fill extends the position's cost basis; a sell fill that
    // empties the position closes the round trip and starts the cooldown.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      const price = BigInt(fill.price);
      const qty = BigInt(fill.qty);
      if (fill.side === 'buy') {
        fillPriceQty += price * qty;
        fillQty += qty;
        buyFillCount += 1;
        if (entryBar < 0) entryBar = state.seq;
      } else if (fill.side === 'sell') {
        if (!state.positions.has(SYMBOL)) {
          fillPriceQty = 0n;
          fillQty = 0n;
          buyFillCount = 0;
          entryBar = -1;
          roundTrips += 1;
          lastExitSeq = state.seq;
        }
      }
    }

    if (state.warmingUp) return [];
    const seq = state.seq;
    if (seq >= 1439) return []; // never order on the last batch (after_end)

    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);
    const heldQty = held?.qty ?? 0n;

    // --- managing an open position ---------------------------------------
    if (heldQty > 0n) {
      const avg = avgFillPrice();
      if (avg !== null && avg > 0n) {
        const takeProfitAt = (avg * (BPS + BigInt(TAKE_PROFIT_BPS))) / BPS;
        const stopAt = (avg * (BPS - BigInt(HARD_STOP_BPS))) / BPS;
        const heldBars = entryBar >= 0 ? seq - entryBar : 0;
        if (
          close >= takeProfitAt ||
          close <= stopAt ||
          heldBars >= MAX_HOLD_BARS ||
          seq >= FORCE_EXIT_BAR
        ) {
          return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      // Ladder: add the next tranche when the dip deepens to its rung.
      // buyFillCount is the number of tranches already filled, so it
      // indexes the next rung; a rejected buy simply never fills and the
      // rung stays open for the next bar.
      if (buyFillCount < DIP_LEVELS_BPS.length && dipBps() >= BigInt(DIP_LEVELS_BPS[buyFillCount]!)) {
        const notional = (state.equity * BigInt(TRANCHE_BPS[buyFillCount]!)) / BPS;
        const spend = notional > state.cash ? state.cash : notional;
        if (spend >= MIN_NOTIONAL) {
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    // --- flat: look for a fresh dip entry ----------------------------------
    if (roundTrips >= MAX_ROUND_TRIPS) return [];
    if (seq - lastExitSeq < COOLDOWN_BARS) return [];
    if (seq >= NO_ENTRY_AFTER_BAR) return [];
    if (closes.length < HIGH_WINDOW) return [];
    if (dipBps() < BigInt(DIP_LEVELS_BPS[0]!)) return [];

    const notional = (state.equity * BigInt(TRANCHE_BPS[0]!)) / BPS;
    const spend = notional > state.cash ? state.cash : notional;
    if (spend < MIN_NOTIONAL) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
