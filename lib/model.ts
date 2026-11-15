// token-radar: the value model.
//
// One sealed DefiLlama snapshot goes in; a ranked board of pre-token protocols comes out. Every
// number the board carries is derived from the snapshot's own ten fields. There is no name list and
// no hand-picked row: one function scores every protocol, and the category table below is keyed by
// DefiLlama's category names, never by a protocol.
//
// The model, in full:
//
//   multiple    = CATEGORY_MULTIPLES[category] ?? DEFAULT_MULTIPLE
//   base        = tvl_usd x multiple
//   growthMult  = 1 + clamp(change_7d ?? 0, -50, 120) / 100 x 0.35
//   maturity    = 0.70 + 0.30 x min(ageDays ?? 365, 1095) / 1095
//   implied     = max(1, round(base x growthMult x maturity))
//
// A confidence band wraps the point estimate. The band is wider for young protocols and for a
// missing seven-day figure, because those are the rows the snapshot knows least about:
//
//   u     = 0.22 + 0.20 x (1 - min(ageDays ?? 365, 1095) / 1095) + (change_7d === null ? 0.10 : 0)
//   low   = max(1, round(implied x (1 - u)))
//   high  = round(implied x (1 + u))
//
// The signal score (0..100) is a second, independent reading: 40 points for age, 35 for TVL on a
// log scale from $5M to $5B, 25 for clamped seven-day growth. It answers "how much evidence is
// there?" while implied value answers "what would the record support?".
//
// The board is a fixed 300 rows: the 40 watchlist slugs first, then every pre-token protocol below
// the watchlist floor, then the strongest pre-token protocols at or above the floor that the house
// rule left out, minus the exchanges and wrapped/staked products. Live-token protocols never enter
// the ranking; they are carried in a separate set for the page's Live token tab.

/** One protocol record: exactly the ten fields the sealed snapshot carries. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants. They are fixed here, stated on the page, and never tuned per row. */
export interface ModelConstants {
  default_multiple: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  band_base: number;
  band_youth: number;
  band_missing_growth: number;
  signal_age_weight: number;
  signal_tvl_weight: number;
  signal_growth_weight: number;
  tvl_log_floor: number;
  tvl_log_ceiling: number;
}

export const MODEL: ModelConstants = {
  default_multiple: 0.25,
  growth_floor: -50,
  growth_cap: 120,
  growth_weight: 0.35,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  unknown_age_days: 365,
  band_base: 0.22,
  band_youth: 0.2,
  band_missing_growth: 0.1,
  signal_age_weight: 40,
  signal_tvl_weight: 35,
  signal_growth_weight: 25,
  tvl_log_floor: 5_000_000,
  tvl_log_ceiling: 5_000_000_000,
};

/** The model's name, shown on the page and in the provenance line. */
export const MODEL_VERSION = 'radar-2.1';

/** How many rows the board targets. The gate takes 100 to 4,000; the snapshot's launch subjects set the rest. */
export const BOARD_SIZE = 300;

/**
 * The category multiple: a protocol's TVL is discounted by how much of a token's value the category
 * tends to keep. A real-world-asset issuer's book supports more than a bridge's throughput. The
 * table is stated on the page exactly as it is applied here; an unlisted category takes 0.25.
 */
export const CATEGORY_MULTIPLES: ReadonlyArray<readonly [string, number]> = [
  ['RWA', 0.42],
  ['Lending', 0.35],
  ['CDP', 0.34],
  ['CDP Manager', 0.34],
  ['Derivatives', 0.3],
  ['Interest Rate Derivatives', 0.3],
  ['Dexs', 0.28],
  ['Yield', 0.24],
  ['Yield Aggregator', 0.24],
  ['Onchain Capital Allocator', 0.22],
  ['Bridge', 0.2],
  ['Canonical Bridge', 0.2],
  ['Cross Chain Bridge', 0.2],
];

/** The multiple lookup built once from the table above. */
const MULTIPLE_BY_CATEGORY: ReadonlyMap<string, number> = new Map(CATEGORY_MULTIPLES);

/** The category's multiple, or the default when DefiLlama names no category or an unlisted one. */
export function categoryMultiple(category: string | null): number {
  if (category === null) return MODEL.default_multiple;
  return MULTIPLE_BY_CATEGORY.get(category) ?? MODEL.default_multiple;
}

/** The value model's own reading of one row, kept so the detail view can show the arithmetic. */
export interface Score {
  implied: number;
  low: number;
  high: number;
  band: number;
  signal: number;
  multiple: number;
  base: number;
  growthPct: number;
  growthMult: number;
  maturity: number;
  ageDays: number | null;
  ageUsed: number;
  signalAge: number;
  signalTvl: number;
  signalGrowth: number;
}

const DAY_MS = 86_400_000;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `listedAt` to `asOf`, floored at zero; null when either date is unusable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** A protocol records no token when both the CoinGecko id and the symbol are absent. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version marker: a name ending in V2, v2, 2.0 and the like is another protocol's pool. */
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A wrapper's whole-word marker: wrapped, staked or staking. */
const WRAPPER_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * Categories whose record is a product of an asset that already trades: a bridge carries other
 * chains' assets, a staking pool carries a chain's asset, and a stablecoin wrapper carries a
 * stablecoin. The watchlist rule leaves them out, and a launch radar should too: the rules name
 * WBTC, Binance staked ETH and USDT0 as exactly the records that are not a token still to come.
 */
const PRODUCT_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'Stablecoin Wrapper',
]);

/** Whether a pre-token protocol is still a credible launch subject rather than a product of one. */
export function isLaunchSubject(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category === 'CEX') return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSION_MARKER.test(p.name)) return false;
  if (WRAPPER_WORD.test(p.name)) return false;
  return true;
}

/** The full score of one protocol under `model`. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, model: ModelConstants = MODEL): Score {
  const age = ageDays(asOf, p.listed_at);
  const ageUsed = age ?? model.unknown_age_days;
  const multiple = categoryMultiple(p.category);
  const base = p.tvl_usd * multiple;

  const rawGrowth = p.change_7d ?? 0;
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;

  const maturity = model.maturity_floor + (Math.min(Math.max(ageUsed, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(base * growthMult * maturity));

  const band = model.band_base + model.band_youth * (1 - Math.min(Math.max(ageUsed, 0), model.maturity_days) / model.maturity_days) + (p.change_7d === null ? model.band_missing_growth : 0);
  const low = Math.max(1, Math.round(implied * (1 - band)));
  const high = Math.round(implied * (1 + band));

  const ageShare = Math.min(Math.max(ageUsed, 0), model.maturity_days) / model.maturity_days;
  const signalAge = model.signal_age_weight * ageShare;
  const tvlSpan = Math.log10(model.tvl_log_ceiling) - Math.log10(model.tvl_log_floor);
  const tvlShare = clamp((Math.log10(Math.max(p.tvl_usd, 1)) - Math.log10(model.tvl_log_floor)) / tvlSpan, 0, 1);
  const signalTvl = model.signal_tvl_weight * tvlShare;
  const growthShare = clamp((growthPct - model.growth_floor) / (model.growth_cap - model.growth_floor), 0, 1);
  const signalGrowth = model.signal_growth_weight * growthShare;
  const signal = clamp(Math.round(signalAge + signalTvl + signalGrowth), 0, 100);

  return {
    implied,
    low,
    high,
    band: round4(band),
    signal,
    multiple,
    base: Math.round(base),
    growthPct: round2(growthPct),
    growthMult: round4(growthMult),
    maturity: round4(maturity),
    ageDays: age,
    ageUsed,
    signalAge: round2(signalAge),
    signalTvl: round2(signalTvl),
    signalGrowth: round2(signalGrowth),
  };
}

/** One step of a farm plan, as board.json carries it: one string with the action, cost and time. */
export type FarmStep = string;

/** A protocol's farm-plan family, chosen from its DefiLlama category. */
export type FarmFamily = 'lending' | 'trading' | 'vault' | 'bridge' | 'other';

/** The family whose plan a category gets. */
export function farmFamily(category: string | null): FarmFamily {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lending';
  if (c.includes('dex') || c.includes('derivative') || c.includes('perpetual') || c.includes('option') || c.includes('basis') || c.includes('prediction')) return 'trading';
  if (c.includes('yield') || c.includes('rwa') || c.includes('allocator') || c.includes('curator') || c.includes('vault') || c.includes('index')) return 'vault';
  if (c.includes('bridge') || c.includes('chain') || c.includes('restak') || c.includes('staking')) return 'bridge';
  return 'other';
}

/** The first chain a protocol names, or a neutral phrase. Only the record's own chain list is read. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The capital one position needs, scaled by the protocol's TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 250;
  if (tvl >= 1_000_000_000) return 200;
  if (tvl >= 250_000_000) return 150;
  if (tvl >= 50_000_000) return 100;
  return 50;
}

/** The gas estimate for one chain, from the chain's own name: a coarse, concrete number. */
function gasFor(chain: string): string {
  if (chain === 'Ethereum') return '$8–$20';
  if (chain === 'Solana' || chain === 'Sui' || chain === 'Aptos' || chain === 'Near') return 'under $1';
  if (chain === 'Base' || chain === 'Arbitrum' || chain === 'Optimism' || chain === 'Polygon' || chain === 'BNB Chain') return '$1–$3';
  return '$2–$6';
}

/** How long a qualifying position should stay open, from the protocol's age. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** One step's string: action, budget, time. Every step is kept inside the gate's 20..600 characters. */
function step(action: string, cost: string, time: string): FarmStep {
  let s = `${action} Budget: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596).trimEnd()} ...`;
  if (s.length < 20) s = `${s} Use only funds you can leave in place.`;
  return s;
}

/**
 * A protocol's farm plan: six numbered steps, each with concrete cost and time, derived only from
 * the protocol's own record (name, first chain, category, TVL and age). The template varies by
 * category family and by size, and the name is always interpolated, never matched.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null, family: FarmFamily = farmFamily(p.category)): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p.tvl_usd);
  const gas = gasFor(chain);
  const hold = holdDaysFor(age);
  const name = p.name;

  const prep = step(
    `Open a fresh wallet on ${chain} and fund it with $${capital} of USDC plus ${gas} of gas; keep the rest of your funds in a separate wallet.`,
    `${gas} of gas`,
    '10 minutes',
  );

  const core: Record<FarmFamily, FarmStep> = {
    lending: step(
      `Supply $${capital} of USDC to ${name} on ${chain}, then borrow about 30% of it against the position and keep both sides open.`,
      `$${capital} of capital and ${gas} of fees`,
      '20 minutes to set up',
    ),
    trading: step(
      `Deposit $${capital} of USDC as margin at ${name} on ${chain} and open one small hedged position; keep the margin above 200% of the position.`,
      `$${capital} of margin and ${gas} of fees`,
      '20 minutes to set up',
    ),
    vault: step(
      `Deposit $${capital} of USDC into ${name}'s flagship vault on ${chain} and leave it through at least one full epoch or reporting period.`,
      `$${capital} of capital and ${gas} of fees`,
      '15 minutes to set up',
    ),
    bridge: step(
      `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside ${name}'s own app rather than moving them again.`,
      `${gas} of bridge and gas fees`,
      '20 minutes to set up',
    ),
    other: step(
      `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open long enough to appear in two monthly snapshots.`,
      `$${capital} of capital and ${gas} of fees`,
      '15 minutes to set up',
    ),
  };

  const activity: Record<FarmFamily, FarmStep> = {
    lending: step(
      `Make one qualifying action a week on ${name}: repay a little, borrow again, or vote if a governance snapshot opens.`,
      `about ${gas} of gas a week`,
      '10 minutes a week',
    ),
    trading: step(
      `Trade once a week on ${name}, even a $20 round trip, so the wallet records repeat activity across separate weeks.`,
      `about ${gas} of gas a week plus trading fees`,
      '10 minutes a week',
    ),
    vault: step(
      `Check ${name}'s vault page weekly and claim any points or rewards it publishes; never pay to claim and never share a seed phrase.`,
      `no fee to check; ${gas} only when you claim`,
      '10 minutes a week',
    ),
    bridge: step(
      `Use ${name} once a week for a small transfer or swap, and check its governance forum for a snapshot you can vote on.`,
      `about ${gas} of gas a week`,
      '10 minutes a week',
    ),
    other: step(
      `Repeat one small action a week on ${name} — a deposit, a swap or a governance vote — from the same wallet.`,
      `about ${gas} of gas a week`,
      '10 minutes a week',
    ),
  };

  const duration = step(
    `Keep the position open for ${hold} days so the activity lands in more than one snapshot; do not move the capital out early.`,
    `the $${capital} stays in the position`,
    `${hold} days`,
  );

  const governance = step(
    `Check ${name}'s governance forum and its official points page weekly, and vote on any snapshot that names a token or a distribution.`,
    'no fee to check the forum',
    '10 minutes a week',
  );

  const safety = step(
    `Before withdrawing, confirm ${name}'s official app address from its own documentation, claim only there, and never approve an unlimited allowance.`,
    `${gas} for the final withdrawal`,
    '15 minutes',
  );

  const log = step(
    `Write the wallet address, every deposit and the dates in a farm log, so you can repeat the position or unwind it after any announcement.`,
    'no cost beyond the log',
    '5 minutes',
  );

  return [prep, core[family], activity[family], duration, governance, safety, log].slice(0, 6);
}

/** One row of board.json: the ranked board's row, with its model arithmetic and its plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  low_usd: number;
  high_usd: number;
  confidence: number;
  signal: number;
  farm_steps: FarmStep[];
  model: {
    version: string;
    multiple: number;
    base_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_used_days: number;
    signal_age: number;
    signal_tvl: number;
    signal_growth: number;
  };
}

/** The live-token protocol the page shows on its Live token tab: a fact, not a model. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
}

/** The compact view of a board row that data.js carries for the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  low_usd: number;
  high_usd: number;
  confidence: number;
  signal: number;
  farm_steps: FarmStep[];
  multiple: number;
  base_usd: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_used_days: number;
  signal_age: number;
  signal_tvl: number;
  signal_growth: number;
}

/** Everything the page renders, as one deterministic object. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: ModelConstants;
  category_multiples: ReadonlyArray<readonly [string, number]>;
  stats: {
    watchlist_total: number;
    watchlist_covered: number;
    board_size: number;
    pre_token_total: number;
    live_total: number;
    below_floor: number;
    off_list: number;
  };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Rows ordered by the model, strongest first: implied desc, TVL desc, slug asc. */
function rankOrder(a: { implied: number; tvl: number; slug: string }, b: { implied: number; tvl: number; slug: string }): number {
  if (a.implied !== b.implied) return b.implied - a.implied;
  if (a.tvl !== b.tvl) return b.tvl - a.tvl;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** The protocols the board ranks, in board order. */
export function selectSubjects(snapshot: Snapshot): SnapshotProtocol[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p] as const));
  const chosen = new Map<string, SnapshotProtocol>();

  // Tier 1: the house watchlist, every slug, exactly as the snapshot names them.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }

  // Tier 2: every pre-token protocol below the floor. These are the early rows the radar exists for.
  const belowFloor = snapshot.protocols.filter((p) => !chosen.has(p.slug) && isPreToken(p) && p.tvl_usd < snapshot.floor_usd);
  const belowScored = belowFloor
    .map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of) }))
    .sort((a, b) => rankOrder({ implied: a.s.implied, tvl: a.p.tvl_usd, slug: a.p.slug }, { implied: b.s.implied, tvl: b.p.tvl_usd, slug: b.p.slug }));
  for (const { p } of belowScored) {
    if (chosen.size >= BOARD_SIZE) break;
    chosen.set(p.slug, p);
  }

  // Tier 3: pre-token protocols at or above the floor that the house rule left out — never an
  // exchange, a versioned pool or a wrapped/staked product. They fill the board to BOARD_SIZE.
  if (chosen.size < BOARD_SIZE) {
    const atFloor = snapshot.protocols.filter((p) => !chosen.has(p.slug) && p.tvl_usd >= snapshot.floor_usd && isLaunchSubject(p));
    const atScored = atFloor
      .map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of) }))
      .sort((a, b) => rankOrder({ implied: a.s.implied, tvl: a.p.tvl_usd, slug: a.p.slug }, { implied: b.s.implied, tvl: b.p.tvl_usd, slug: b.p.slug }));
    for (const { p } of atScored) {
      if (chosen.size >= BOARD_SIZE) break;
      chosen.set(p.slug, p);
    }
  }

  return [...chosen.values()];
}

/** The ranked board: every selected protocol scored, ordered and ranked 1..N. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const watched = new Set(snapshot.watchlist);
  const scored = selectSubjects(snapshot).map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, model) }));
  scored.sort((a, b) => rankOrder({ implied: a.s.implied, tvl: a.p.tvl_usd, slug: a.p.slug }, { implied: b.s.implied, tvl: b.p.tvl_usd, slug: b.p.slug }));

  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: s.ageDays,
    watchlist: watched.has(p.slug),
    implied_value_usd: s.implied,
    low_usd: s.low,
    high_usd: s.high,
    confidence: s.band,
    signal: s.signal,
    farm_steps: farmPlan(p, s.ageDays),
    model: {
      version: model === MODEL ? MODEL_VERSION : `${MODEL_VERSION}-alt`,
      multiple: s.multiple,
      base_usd: s.base,
      growth_pct: s.growthPct,
      growth_multiplier: s.growthMult,
      maturity_multiplier: s.maturity,
      age_used_days: s.ageUsed,
      signal_age: s.signalAge,
      signal_tvl: s.signalTvl,
      signal_growth: s.signalGrowth,
    },
  }));
}

/** Every protocol whose token already trades, for the page's Live token tab, by market cap. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
    }));
}

/** One board row as the page's data carries it. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    low_usd: row.low_usd,
    high_usd: row.high_usd,
    confidence: row.confidence,
    signal: row.signal,
    farm_steps: row.farm_steps,
    multiple: row.model.multiple,
    base_usd: row.model.base_usd,
    growth_pct: row.model.growth_pct,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    age_used_days: row.model.age_used_days,
    signal_age: row.model.signal_age,
    signal_tvl: row.model.signal_tvl,
    signal_growth: row.model.signal_growth,
  };
}

/** The board and the page's data, from one snapshot and one model. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watched = new Set(snapshot.watchlist);
  const covered = snapshot.watchlist.filter((slug) => board.some((r) => r.slug === slug)).length;
  const belowFloor = board.filter((r) => r.tvl_usd < snapshot.floor_usd).length;
  const offList = board.filter((r) => !watched.has(r.slug) && r.tvl_usd >= snapshot.floor_usd).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model,
    category_multiples: CATEGORY_MULTIPLES,
    stats: {
      watchlist_total: snapshot.watchlist.length,
      watchlist_covered: covered,
      board_size: board.length,
      pre_token_total: snapshot.protocols.filter(isPreToken).length,
      live_total: live.length,
      below_floor: belowFloor,
      off_list: offList,
    },
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** Why the snapshot is not the document this model scores. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** A finite number, or the fallback. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The snapshot out of a file's text, refused unless it has the shape the model scores. */
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

  const protocols = o.protocols.map((value, i) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = value as Record<string, unknown>;
    if (typeof p.slug !== 'string' || p.slug.length === 0) throw new SnapshotError(`protocol ${i} has no slug`);
    if (typeof p.name !== 'string' || p.name.length === 0) throw new SnapshotError(`protocol ${i} has no name`);
    if (typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) throw new SnapshotError(`protocol ${i} has no TVL`);
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

  const seen = new Set<string>();
  for (const p of protocols) {
    if (seen.has(p.slug)) throw new SnapshotError(`snapshot.json repeats the slug ${p.slug}`);
    seen.add(p.slug);
  }
  const watchlist = (o.watchlist as string[]).slice();
  for (const slug of watchlist) {
    if (!seen.has(slug)) throw new SnapshotError(`the watchlist names ${slug}, which the snapshot does not carry`);
  }

  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist };
}

/** Why a board is not one the gate will take, or null. Mirrors the gate's own rows, plus the model's. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const slugs = new Set<string>();
  for (const row of board) {
    if (slugs.has(row.slug)) return `${row.slug} appears twice`;
    slugs.add(row.slug);
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 100_000_000_000_000) return `${row.slug} has implied value ${row.implied_value_usd}`;
    if (!Number.isSafeInteger(row.rank) || row.rank <= 0) return `${row.slug} has rank ${row.rank}`;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const text of row.farm_steps) {
      const trimmed = text.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `${row.slug} has a farm step of ${trimmed.length} characters`;
    }
  }
  const missing = snapshot.watchlist.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return `all ${board.length} rows share one implied value`;
  return null;
}

/** The page's whole dataset as one script, with no fetch and no network address. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
