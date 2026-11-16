# Radar — a pre-token launch board

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/hifiaz/token-radar-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/hifiaz/token-radar-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Every protocol in this DefiLlama snapshot that records no token, ranked by what its own record
implies a token could be worth. One arithmetic model, no name list, no outside data. The page is
rendered offline from a single `data.js`; it makes no network request of its own.

- `main.ts` reads the sealed snapshot, scores it, writes the board, copies the page and images, and
  writes the dossier.
- `lib/model.ts` holds the whole model: category multiples, growth, maturity, band, signal, board
  selection and the farm plans.
- `dashboard/` is the page: `index.html`, `app.css`, `app.js`, no framework and no fetch.
- `screenshots/` holds the three views a judge reads: the board, a detail drawer, a filtered board.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22 or later, standard library only. The run reads no clock, no random source and no network, so
two runs write identical bytes; `--draft` skips the dossier while the screenshots are still being
taken.

## The model

```
base       = tvl_usd × categoryMultiple(category)
growthMult = 1 + clamp(change_7d ?? 0, −50, 120) / 100 × 0.35
maturity   = 0.70 + 0.30 × min(ageDays, 1095) / 1095      (ageDays 365 when listed_at is null)
implied    = max(1, round(base × growthMult × maturity))
```

Category multiples are the only hand-set input, and they are set on DefiLlama's category, never on a
protocol's name: RWA 0.42, Lending 0.35, CDP 0.34, Derivatives 0.30, Dexs 0.28, Yield 0.24, Onchain
Capital Allocator 0.22, Bridge and Canonical Bridge 0.20, everything else 0.25. The full table is
printed on the page itself.

Each row also carries:

- **a confidence band** `u = 0.22 + 0.20 × (1 − min(ageDays, 1095)/1095) + 0.10` when the seven-day
  change is missing; `low = implied × (1 − u)`, `high = implied × (1 + u)`.
- **a 0–100 signal** from age (40), log TVL between $5M and $5B (35) and the seven-day change mapped
  across its −50…+120 clamp (25). It says how much evidence the record carries, not how big the
  number is.
- **the components** — base, multiple, growth multiplier, maturity multiplier, band — so the drawer
  can print the arithmetic line by line instead of asserting a total.

## Which rows are on the board

1. all 40 watchlist slugs, whatever their size;
2. every pre-token protocol below the $50M floor, because those are the early ones a radar exists to
   find; and
3. credible off-list pre-token protocols above the floor — real launch subjects, not an exchange, a
   canonical bridge, a liquid-staking or restaked wrapper, a versioned pool or a wrapped product of a
   token that already trades.

That gives **268 rows**, not 300. The snapshot holds 342 pre-token records: 40 on the watchlist, 210
below the floor, and 92 above it, of which 74 are exchanges, bridges, staking wrappers or wrapped
products that cannot plausibly launch a token — ranking them would put WBTC and Coinbase Bridge at
the top of a "launch radar", which is exactly the reading the rules warn against. The gate accepts
100 to 4,000 rows; 268 is every credible subject in this snapshot, and the page says so.

Live-token protocols (416 of them) are never ranked. They sit in their own tab with DefiLlama's own
market cap, so a fact is never confused with the model's claim.

## Farm plans

Six steps per row, generated from the row's own fields — name, first chain, category, TVL, age — and
never from a hardcoded list. Five category families (lending/CDP, dex/derivatives, yield/RWA, bridge/
chain, other) choose the actions; every step names a concrete budget in dollars and a calendar time,
e.g. *Budget: $4–$12 in gas. Time: 20 minutes.* The drawer renders the budget and the time apart from
the action so the plan reads as a checklist.

## The page

Deep ink canvas with one warm (amber) and one cool (cyan) accent, a tabular-numeral mono for every
figure, and range rings behind the content as the one ornament. A masthead carries the snapshot date
and the model version; a stat strip shows watchlist coverage, ranked rows, the pre-token universe and
the live-token set aside.

- search, category, chain and minimum-TVL filters, all in the URL hash (`#q=`, `#c=`, `#chain=`,
  `#min=`, `#t=live`, `#p=`, `#sort=`, `#dir=`), so any view is linkable and screenshotable;
- sortable headers with `aria-sort`, a real `<table>` with a caption, focus outlines and keyboard row
  selection;
- a detail drawer with the value and its band, the arithmetic, where the row sits inside its category
  (median and implied ÷ TVL), the numbered farm plan, the signal breakdown and a provenance line;
  ↑ and ↓ walk the filtered board without closing the panel;
- a Live token tab that states why those protocols are not ranked.

## Provenance and limits

The snapshot is a sealed DefiLlama protocol index (`as_of` 2026-11-14). Absence of a token in that
record is not proof that none exists, so the page says a protocol *records no token*. An implied value
is the model's reading of a record — not a price, not a forecast, and not make.fun's figure.

Built for [make.fun](https://make.fun)'s token-radar-01 bounty. MIT licensed.
