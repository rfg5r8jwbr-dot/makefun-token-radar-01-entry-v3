# Token Radar — pre-token protocols ranked by implied value

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?ref=4q7hssxn)
[![rank](https://make.fun/badge/token-radar-01/rfg5r8jwbr-dot/makefun-token-radar-01-entry-v3/rank.svg)](https://make.fun/bounty/token-radar-01?ref=4q7hssxn)
[![reward](https://make.fun/badge/token-radar-01/rfg5r8jwbr-dot/makefun-token-radar-01-entry-v3/reward.svg)](https://make.fun/bounty/token-radar-01?ref=4q7hssxn)

A token launch radar built for the make.fun bounty [token-radar-01](https://make.fun/bounty/token-radar-01?ref=4q7hssxn). It reads the sealed DefiLlama snapshot (758 protocols, snapshot 2026-11-14), finds the protocols that record no token, ranks them by an implied token value, and shows a reader how to farm each one — all in an offline static dashboard.

## What it covers

- **178 pre-token rows** — the whole 40-protocol watchlist (every protocol with at least $50M TVL and no token on record) plus 138 early-radar protocols below the floor that pass the watchlist's own exclusion rule (no bridge, liquid staking/restaking or CEX product, no versioned pool, no wrapped or staked product, no exchange-branded name).
- **24 live-token protocols set aside** — they already trade, so the board shows their market caps, never a model value. Their market-cap-to-TVL ratios are the comparables the model prices the board with.
- **A detail view for every protocol** — the model broken down input by input, its live-token peers in the same category, and a 6-step farm plan written for its category, with a cost and a time for every step.
- **Filters that work** — search by name, slug, category or chain; filter by category, chain, minimum TVL, or watchlist-only; sort by implied value, TVL, 7-day growth, age or multiple; a separate Live token tab.

## The model (radar-4)

Implied value is TVL times the multiple the protocol's own category trades at, adjusted for growth, age and chain breadth. Nothing is hardcoded by name; every number comes from the snapshot.

```
implied = round( tvl_usd x category multiple
  x (1 + clamp(change_7d, -50, 100) / 100 x 0.4)
  x (0.7 + min(age_days, 1460) / 1460 x 0.3)
  x (1 + min(chains - 1, 4) x 0.02) )
```

- **Category multiple**: the median market-cap-to-TVL ratio of the live-token protocols in the same category, winsorized to 0.05–1.00 and shrunk toward the global median of 0.21 by (n × base + 3 × global) / (n + 3), clamped to 0.05–1.00. A category with many comparables keeps its own number — Lending trades near 0.15, Dexs near 0.31, RWA near 0.26. A category with fewer than 3 comparables pools its family of near categories instead of standing on one peer's ratio: the family median is the base, so Risk Curators, with a single comparable, uses the yield family's pooled median (n=23) and lands at 0.17, not 1.00.
- **Growth**: the 7-day TVL change, clamped to −50%…+100% so one spike (the snapshot holds a +4,448% outlier) cannot buy the top rank.
- **Maturity**: age since first listing, up to 4 years. A protocol that has run longest with no token has had the most time to build the thing a token would price.
- **Breadth**: a small premium per extra chain, capped at 4.

Top of the board: Steakhouse Financial ($2.75B TVL, Risk Curators, implied ≈ $417M), Gauntlet ($1.58B, implied ≈ $246M), Veda ($1.56B, implied ≈ $236M).

## Say it plainly

A protocol on this board **records no token** in the snapshot — that is not proof it has none, and no row predicts whether or when a token launches. Implied value is this model's claim, not a price. Farming is activity, not a guarantee of any reward: never pay to claim, and claim only from the link the protocol itself publishes.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

`main.ts` (Node 22, standard library only) reads the snapshot, writes `board.json` and `data.js`, copies `dashboard/` and `screenshots/` into the output directory, and writes `dossier.json` with the vendored `vendor/makefun-board.ts` library. Open `out/dashboard/index.html` in a browser; it renders offline with no network.
