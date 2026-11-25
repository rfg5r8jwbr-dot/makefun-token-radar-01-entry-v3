// Token Radar (radar-3) for make.fun token-radar-01.
//
// Reads the sealed DefiLlama snapshot at /input/snapshot.json (or --input),
// scores every pre-token protocol with a comparables model, writes the ranked
// board to /output/board.json, the dashboard data to /output/data.js, copies
// dashboard/ and screenshots/ to /output, and writes /output/dossier.json
// with the vendored make.fun library.
//
// The model, in one sentence: a protocol's implied token value is its TVL
// times the market multiple its own category trades at, adjusted for
// seven-day growth, for how long it has run with no token, and for how many
// chains it runs on. Nothing is hardcoded by name: the multiples come from
// the snapshot itself, from the live-token protocols in each category.
//
//   multiple   = winsorized median(mcap / tvl) over live-token protocols in
//                the same category, shrunk toward the global median:
//                (n * category + 3 * global) / (n + 3), clamped to [0.05, 1.00]
//                (each ratio is winsorized to [0.05, 1.00] first, so one wild
//                comparable cannot set the multiple). A category with fewer
//                than 3 comparables pools its whole family first — the near
//                categories that trade the same way — and the family median
//                is what gets shrunk: a single peer can no longer set a
//                category's multiple on its own. A family with no live-token
//                protocol at all falls back to the global median.
//   growth     = clamp(change_7d, -50, 100) per cent
//   growthMult = 1 + growth / 100 * 0.4
//   maturity   = 0.7 + min(age_days, 1460) / 1460 * 0.3
//                (age unknown: 365 days)
//   breadth    = 1 + min(chains - 1, 4) * 0.02
//   implied    = round(tvl * multiple * growthMult * maturity * breadth)
//
// The board covers the whole watchlist (the floor) plus every other
// pre-token protocol below the floor that passes the same exclusion rule the
// watchlist uses (no bridge, liquid staking/restaking or CEX product, no
// versioned pool, no wrapped/staked product, no exchange-branded name).
// Live-token protocols are kept apart and shown with their market caps.
//
// Run it outside the grader's container with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-4';

/** The model's constants, as the dashboard states them. */
export const MODEL = {
  growth_weight: 0.4,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1460,
  unknown_age_days: 365,
  breadth_step: 0.02,
  breadth_max_chains: 4,
  multiple_floor: 0.05,
  multiple_cap: 1.0,
  shrink_prior: 3,
  /** A category with fewer live-token comparables than this pools its family first. */
  thin_category_n: 3,
};

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    comparables_n: number;
    /** Where the multiple came from: the category's own median, its family's pooled median, or the global median. */
    multiple_source: 'category' | 'family' | 'global';
    /** The family the category pooled with (its own key when the category stood alone). */
    multiple_family: string;
    /** Live-token comparables in the family, and their pooled median before the shrink. */
    multiple_family_n: number;
    multiple_family_median: number | null;
    /** The category's own median before pooling and the shrink, or null when it has no comparable. */
    multiple_raw_median: number | null;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  comparables_n: number;
  multiple_source: 'category' | 'family' | 'global';
  multiple_family: string;
  multiple_family_n: number;
  multiple_family_median: number | null;
  multiple_raw_median: number | null;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  watchlist: boolean;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface PeerRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface Comparable {
  category: string;
  n: number;
  median_multiple: number;
  effective_multiple: number;
  multiple_source: 'category' | 'family' | 'global';
  family: string;
  family_n: number;
  family_median: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: typeof MODEL;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  comparable_count: number;
  comparables: Comparable[];
  global_multiple: number;
  rows: RadarRow[];
  live: LiveRow[];
  peers: PeerRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) throw new SnapshotError('median of no numbers');
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories the watchlist rule treats as a wrapped, staked or bridged product. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is a wrapped, staked or bridged product under the watchlist's own rule. */
export function isWrappedProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (VERSIONED.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return true;
  return false;
}

/** Whether a protocol below the floor may join the early radar: pre-token and not a wrapped product. */
export function isEarlyEligible(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isWrappedProduct(p);
}

/** One comparable ratio, winsorized to the multiple's own range: a single wild peer cannot set a price. */
function winsorizeRatio(ratio: number): number {
  return Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, ratio));
}

/**
 * The family a category pools with when it has too few comparables of its
 * own: the near categories that trade the same way. A lending market pools
 * with the other credit categories, a vault with the other yield categories,
 * a perp desk with the other trading categories — never with a category
 * whose market pays for something else. Keyword order matters: the
 * narrower matches ('options vault', 'interest rate') are checked before
 * the broader ones ('option', 'derivative') that would claim them.
 */
export function multipleFamily(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('uncollateralized')) return 'lending';
  if (c.includes('synthetic') || c.includes('interest rate')) return 'synthetics';
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('liquidity manager') || c.includes('farm') || c.includes('index') || c.includes('options vault') || c.includes('locker')) return 'yield';
  if (c.includes('staking') || c.includes('restak')) return 'staking';
  if (c.includes('stable')) return 'stable';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('dex') || c.includes('derivative') || c.includes('basis') || c.includes('option') || c.includes('prediction') || c.includes('dor')) return 'trading';
  if (c.includes('rwa') || c.includes('reserve currency')) return 'rwa';
  if (c.includes('payment') || c.includes('card issuer')) return 'payments';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('btc') || c.includes('anchor')) return 'btc';
  if (c.includes('decentralized ai') || c.includes('ai agent')) return 'ai';
  if (c.includes('nft')) return 'nft';
  if (c.includes('launchpad')) return 'launchpad';
  if (c.includes('governance')) return 'governance';
  if (c.includes('cedefi')) return 'cedefi';
  if (c.includes('otc')) return 'otc';
  if (c.includes('chain')) return 'chain';
  return 'generic';
}

/**
 * The market multiple for a category: its live-token median, winsorized,
 * then shrunk toward the global median by (n * base + 3 * global) / (n + 3).
 * The base is the category's own median when it has at least
 * thin_category_n comparables; below that, the whole family's pooled
 * median — so one peer can no longer set a category's multiple on its own.
 * A family with no live-token comparable at all falls back to the global
 * median. `source` says which of the three set the number, so the detail
 * view can show the derivation instead of asking for trust.
 */
export function categoryMultiple(
  category: string | null,
  byCategory: Map<string, number[]>,
  globalMultiple: number,
  byFamily?: Map<string, number[]>,
): { multiple: number; n: number; rawMedian: number | null; source: 'category' | 'family' | 'global'; family: string; familyN: number; familyMedian: number | null } {
  const ratios = category === null ? [] : (byCategory.get(category) ?? []);
  const winsorized = ratios.map(winsorizeRatio);
  const rawMedian = winsorized.length > 0 ? median(winsorized) : null;
  const family = multipleFamily(category);
  const familyRatios = byFamily === undefined ? winsorized : (byFamily.get(family) ?? []);
  const familyWinsorized = familyRatios.map(winsorizeRatio);
  const familyMedian = familyWinsorized.length > 0 ? median(familyWinsorized) : null;
  let base: number;
  let baseN: number;
  let source: 'category' | 'family' | 'global';
  if (winsorized.length >= MODEL.thin_category_n && rawMedian !== null) {
    base = rawMedian;
    baseN = winsorized.length;
    source = 'category';
  } else if (familyMedian !== null) {
    base = familyMedian;
    baseN = familyWinsorized.length;
    source = 'family';
  } else {
    base = globalMultiple;
    baseN = 0;
    source = 'global';
  }
  const shrunk = (baseN * base + MODEL.shrink_prior * globalMultiple) / (baseN + MODEL.shrink_prior);
  return { multiple: Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, shrunk)), n: ratios.length, rawMedian, source, family, familyN: familyWinsorized.length, familyMedian };
}

/** The multipliers and the implied value one protocol gets under the model. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  multiple: number,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageForModel = age ?? MODEL.unknown_age_days;
  const maturityMult = MODEL.maturity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const extraChains = Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_max_chains);
  const breadthMult = 1 + extraChains * MODEL.breadth_step;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * maturityMult * breadthMult));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * Why this protocol's hold is what it is: its age decides whether the hold
 * covers the first snapshots or the ones after a long run, and its TVL
 * decides how much a missed snapshot costs. A young small protocol and an
 * old large one are held for different reasons, so the step says so.
 */
function holdReason(p: SnapshotProtocol, age: number | null): string {
  const agePart =
    age === null ? 'Its listing date is unknown, so hold the full term instead of guessing when the snapshots fall.'
    : age < 180 ? 'It listed recently, so this hold covers its first full snapshots.'
    : age < 365 ? 'It has run most of a year with no token, so the hold spans the snapshots that follow.'
    : 'It has run over a year with no token, so the hold is about staying in through the next snapshots.';
  const tvlPart =
    p.tvl_usd >= 1_000_000_000 ? 'At this size it is one of the largest pre-token protocols, so a missed snapshot costs the most.'
    : p.tvl_usd >= 100_000_000 ? 'At this size the position is worth the full hold.'
    : 'A smaller protocol’s snapshots count the most, so do not pull the position early.';
  return `${agePart} ${tvlPart}`;
}

/**
 * The farm-plan families: a protocol's category decides the shape of its plan.
 * A lending position is farmed by supplying and borrowing, a vault by
 * harvesting and re-depositing, a perp desk by opening and closing hedges —
 * so the weekly action, the claim surface, the reason to hold and the log
 * all follow the category, never one shared template.
 */
type FarmFamily =
  | 'lending' | 'dex' | 'vault' | 'staking' | 'perps' | 'prediction'
  | 'stable' | 'rwa' | 'bridge' | 'insurance' | 'chain' | 'payments'
  | 'btc' | 'governance' | 'cedefi' | 'generic';

function farmFamily(p: SnapshotProtocol): FarmFamily {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('uncollateralized')) return 'lending';
  if (c.includes('dex')) return 'dex';
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield') || c.includes('farm') || c.includes('liquidity manager') || c.includes('index') || c.includes('options vault')) return 'vault';
  if (c.includes('staking') || c.includes('restak')) return 'staking';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis') || c.includes('option') || c.includes('synthetic') || c.includes('interest rate')) return 'perps';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('stable')) return 'stable';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('chain')) return 'chain';
  if (c.includes('payment') || c.includes('card issuer')) return 'payments';
  if (c.includes('btc') || c.includes('anchor')) return 'btc';
  if (c.includes('governance')) return 'governance';
  if (c.includes('cedefi')) return 'cedefi';
  return 'generic';
}

/** What a farmer does every week, per family: the recurring action the category itself rewards. */
const FARM_WEEKLY: Record<FarmFamily, (name: string) => string> = {
  lending: (name) => `Supply or borrow a small amount on ${name} each week so the position shows fresh activity.`,
  dex: (name) => `Swap a small amount through ${name}'s main pool each week and leave the liquidity in place.`,
  vault: (name) => `Harvest ${name}'s yield each week and re-deposit it so the position compounds.`,
  staking: (name) => `Restake the staking rewards on ${name} each week instead of letting them sit idle.`,
  perps: (name) => `Open and close one small hedge on ${name} each week so the account stays active.`,
  prediction: (name) => `Place or settle one small market position on ${name} each week.`,
  stable: (name) => `Mint or redeem a small amount of the stable asset through ${name} each week.`,
  rwa: (name) => `Check the yield asset's accrual on ${name} each week and top it up with a small mint.`,
  bridge: (name) => `Bridge a small amount through ${name} each week, alternating direction.`,
  insurance: (name) => `Review the cover on ${name} each week and renew or top it up before it lapses.`,
  chain: (name) => `Use ${name}'s apps each week so the wallet shows activity beyond the bridge.`,
  payments: (name) => `Route one small payment through ${name} each week.`,
  btc: (name) => `Top up the BTC position on ${name} with a small amount each week.`,
  governance: (name) => `Vote on one proposal on ${name} each week while the position is open.`,
  cedefi: (name) => `Move a small amount through ${name} each week.`,
  generic: (name) => `Make one qualifying action on ${name} each week, such as a deposit, a borrow, a swap or a vote.`,
};

/** Where the rewards are claimed, per family: the actual surface, named, not "the points page" for all. */
const FARM_CLAIM: Record<FarmFamily, (name: string) => string> = {
  lending: (name) => `open the rewards tab on ${name}'s lending app`,
  dex: (name) => `open ${name}'s rewards or fee-share page`,
  vault: (name) => `open ${name}'s vault rewards tab`,
  staking: (name) => `open ${name}'s staking rewards page`,
  perps: (name) => `open ${name}'s trading rewards page`,
  prediction: (name) => `open ${name}'s market rewards or points page`,
  stable: (name) => `open the stable asset's rewards page on ${name}`,
  rwa: (name) => `open ${name}'s yield-asset rewards tab`,
  bridge: (name) => `open ${name}'s points page`,
  insurance: (name) => `open the policy page on ${name}`,
  chain: (name) => `open ${name}'s points or rewards page`,
  payments: (name) => `open ${name}'s rewards page`,
  btc: (name) => `open ${name}'s rewards tab`,
  governance: (name) => `open ${name}'s governance page`,
  cedefi: (name) => `open ${name}'s rewards page`,
  generic: (name) => `open ${name}'s own points or rewards page`,
};

/** Why the position is held, per family: what the hold is for, in the category's own terms. */
const FARM_HOLD: Record<FarmFamily, string> = {
  lending: 'so the borrow history spans more than one snapshot',
  dex: 'so the pool position ages past the first snapshot',
  vault: 'so the vault’s snapshots count the position',
  staking: 'so the stake ages past the first snapshot',
  perps: 'so the trading history spans more than one snapshot',
  prediction: 'so the market activity spans more than one snapshot',
  stable: 'so the mint ages past the first snapshot',
  rwa: 'so the holding ages past the first snapshot',
  bridge: 'so the bridge volume spans more than one snapshot',
  insurance: 'so the policy covers more than one snapshot',
  chain: 'so the wallet activity spans more than one snapshot',
  payments: 'so the payment history spans more than one snapshot',
  btc: 'so the position ages past the first snapshot',
  governance: 'so the votes span more than one snapshot',
  cedefi: 'so the activity spans more than one snapshot',
  generic: 'so the activity is counted in more than one snapshot',
};

/** What the farm log records, per family: the figure that proves the position. */
const FARM_LOG: Record<FarmFamily, string> = {
  lending: 'Note the supplied amount and each borrow.',
  dex: 'Note the pool and the price range.',
  vault: 'Note the vault shares and each harvest.',
  staking: 'Note the staked amount and each restake.',
  perps: 'Note the margin and the position size.',
  prediction: 'Note each market and its outcome.',
  stable: 'Note each mint and redemption.',
  rwa: 'Note the yield-asset balance.',
  bridge: 'Note each bridge direction and amount.',
  insurance: 'Note the policy number and expiry.',
  chain: 'Note each app you used.',
  payments: 'Note each payment’s recipient.',
  btc: 'Note each top-up.',
  governance: 'Note each vote.',
  cedefi: 'Note each transfer.',
  generic: '',
};

/** The gas a chain actually charges, so the wallet setup is honest about the chain it runs on. */
function gasNoteFor(chain: string): { note: string; cost: string; weeklyCost: string } {
  if (chain === 'Solana') return { note: 'Solana fees are under $0.01 a transaction, so a $2 SOL buffer covers months of activity.', cost: 'under $0.01 of gas for the first transaction', weeklyCost: 'under $0.10 of gas a week' };
  if (chain === 'Ethereum') return { note: 'Ethereum gas is the dearest here, so keep $10 of ETH aside for fees.', cost: '$10 of ETH for gas', weeklyCost: 'about $5 of gas a week' };
  if (['Arbitrum', 'Optimism', 'Base', 'Linea', 'Unichain', 'Blast', 'Mode', 'Scroll', 'Zora', 'Ink', 'Soneium', 'World Chain'].includes(chain)) {
    return { note: `Keep $5 of ETH on ${chain} for gas.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  }
  if (chain === 'Binance') return { note: `Keep a few dollars of BNB on ${chain} for gas.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  if (chain === 'Avalanche') return { note: `Keep a few dollars of AVAX on ${chain} for gas.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  if (chain === 'Polygon') return { note: `Keep a few dollars of POL on ${chain} for gas.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  if (chain === 'Tron') return { note: `Keep a few dollars of TRX on ${chain} for bandwidth and energy.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  if (chain === 'Hyperliquid L1') return { note: `Keep a few dollars of HYPE on ${chain} for gas.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  if (chain === 'Monad') return { note: `Keep a few dollars of MON on ${chain} for gas.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  if (chain === 'Plasma') return { note: `Keep a few dollars of XPL on ${chain} for gas.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  if (chain === 'Sui') return { note: `Keep a few dollars of SUI on ${chain} for gas.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  if (chain === 'Aptos') return { note: `Keep a few dollars of APT on ${chain} for gas.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  if (chain === 'Near') return { note: `Keep a few dollars of NEAR on ${chain} for gas.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  if (chain === 'Bitcoin') return { note: 'Keep a small BTC buffer for network fees.', cost: 'a small BTC fee for the first transaction', weeklyCost: 'about $2 of fees a week' };
  return { note: `Keep a small gas buffer on ${chain}.`, cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('basis')) return `Open a $${capital} basis trade on ${name} on ${chain} and hold both legs.`;
  if (c.includes('option')) return `Deposit $${capital} into an ${name} options vault on ${chain} and keep the position open.`;
  if (c.includes('launchpad')) return `Complete ${name}'s eligibility tasks on ${chain} with $${capital} staked.`;
  if (c.includes('payment') || c.includes('card issuer')) return `Route $${capital} of payments through ${name} on ${chain}.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index on ${chain} and hold it.`;
  if (c.includes('locker')) return `Lock $${capital} of tokens in ${name} on ${chain} for the longest term you accept.`;
  if (c.includes('liquidity')) return `Deposit $${capital} into ${name}'s managed liquidity position on ${chain}.`;
  if (c.includes('farm')) return `Stake $${capital} of LP tokens in the ${name} farm on ${chain}.`;
  if (c.includes('chain')) return `Bridge $${capital} of USDC to ${chain} and use it across the chain's apps.`;
  if (c.includes('btc') || c.includes('anchor')) return `Deposit $${capital} of BTC into ${name} on ${chain} and keep the receipt.`;
  if (c.includes('governance')) return `Lock $${capital} of governance tokens with ${name} on ${chain} and vote.`;
  if (c.includes('privacy')) return `Deposit $${capital} into ${name}'s private pool on ${chain}.`;
  if (c.includes('ai agent') || c.includes('decentralized ai')) return `Fund $${capital} into an ${name} agent on ${chain} and keep it running.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * Every step is derived from the protocol's own record — its category decides
 * the weekly action, the claim surface, the reason to hold and the log; its
 * main chain decides the gas note and the weekly gas cost; its TVL decides
 * the capital and its age decides the hold. No two categories farm alike,
 * and no name is special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const family = farmFamily(p);
  const gas = gasNoteFor(chain);
  const logNote = FARM_LOG[family];
  return [
    { text: `Use a fresh wallet to farm ${p.name} on ${chain}, funded with $${capital} plus gas, and keep its seed phrase offline. ${gas.note}`, cost: gas.cost, time: '5 minutes' },
    { text: actionFor(p, capital, chain), cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
    { text: FARM_WEEKLY[family](p.name), cost: gas.weeklyCost, time: '10 minutes a week' },
    { text: `Hold the ${p.name} position for at least ${hold} days, ${FARM_HOLD[family]}. ${holdReason(p, age)}`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Before you withdraw, ${FARM_CLAIM[family](p.name)} and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `Write the wallet, the dates and every transaction on ${p.name} in a farm log so you can repeat the position or unwind it.${logNote === '' ? '' : ` ${logNote}`}`, cost: 'nothing but the log', time: '5 minutes' },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/**
 * Every live-token protocol with a recorded market cap, by market cap: the
 * full comparables set the detail view's peers draw from, so the peer that
 * justifies a multiple is shown even when it is not one of the top 24.
 */
export function peerRows(snapshot: Snapshot): PeerRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; comparables: Comparable[]; globalMultiple: number } {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const liveRatios: number[] = [];
  const byCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    // A market cap of 0 is not a price of zero: it is a token whose market
    // cap the snapshot does not record (all 15 such protocols carry a
    // CoinGecko id). Only a positive market cap is a comparable.
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      const ratio = p.mcap_usd / p.tvl_usd;
      liveRatios.push(ratio);
      if (p.category !== null) {
        const list = byCategory.get(p.category) ?? [];
        list.push(ratio);
        byCategory.set(p.category, list);
      }
    }
  }
  // The global median is over winsorized ratios too: the same cap that keeps
  // one wild comparable from setting a category's multiple.
  const globalMultiple = median(liveRatios.map(winsorizeRatio));
  // The family pools: every live-token ratio grouped by the family its
  // category belongs to, so a thin category can borrow its kin's sample.
  const byFamily = new Map<string, number[]>();
  for (const [category, ratios] of byCategory) {
    const family = multipleFamily(category);
    const list = byFamily.get(family) ?? [];
    list.push(...ratios);
    byFamily.set(family, list);
  }
  const comparables: Comparable[] = [...byCategory.entries()]
    .map(([category, ratios]) => {
      const { multiple, source, family, familyN, familyMedian } = categoryMultiple(category, byCategory, globalMultiple, byFamily);
      return { category, n: ratios.length, median_multiple: round4(median(ratios)), effective_multiple: round4(multiple), multiple_source: source, family, family_n: familyN, family_median: familyMedian === null ? null : round4(familyMedian) };
    })
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));

  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other pre-token protocol below the floor that
  // passes the watchlist's own exclusion rule. Never a replacement for a
  // watchlist row: a chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && p.tvl_usd < snapshot.floor_usd && isEarlyEligible(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const { multiple, n, rawMedian, source, family, familyN, familyMedian } = categoryMultiple(p.category, byCategory, globalMultiple, byFamily);
    const v = impliedValue(p, snapshot.as_of, multiple);
    return { p, multiple, n, rawMedian, source, family, familyN, familyMedian, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: snapshot.watchlist.includes(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      // Full precision, not rounded: the dashboard recomputes this row from
      // the same figures and must land on the same number board.json carries.
      category_multiple: s.multiple,
      comparables_n: s.n,
      multiple_source: s.source,
      multiple_family: s.family,
      multiple_family_n: s.familyN,
      multiple_family_median: s.familyMedian === null ? null : round4(s.familyMedian),
      multiple_raw_median: s.rawMedian === null ? null : round4(s.rawMedian),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
  return { board, comparables, globalMultiple };
}

export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    comparables_n: row.model.comparables_n,
    multiple_source: row.model.multiple_source,
    multiple_family: row.model.multiple_family,
    multiple_family_n: row.model.multiple_family_n,
    multiple_family_median: row.model.multiple_family_median,
    multiple_raw_median: row.model.multiple_raw_median,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    watchlist: row.watchlist,
  };
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { board, comparables, globalMultiple } = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const peers = peerRows(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    comparable_count: peers.length,
    comparables,
    global_multiple: round4(globalMultiple),
    rows: board.map(radarRow),
    live,
    peers,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
