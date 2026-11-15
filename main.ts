// token-radar: the entrypoint.
//
// Reads the sealed snapshot (/input/snapshot.json, or --input <file|dir>), scores every pre-token
// protocol with lib/model.ts, writes the ranked board to /output/board.json and the page's data to
// /output/data.js, copies dashboard/ and screenshots/ beside them, then writes /output/dossier.json
// with the vendored make-fun library.
//
// Determinism is part of the contract: the grader runs this twice and compares bytes. Nothing here
// reads the clock, the network, the environment's locale or a random source. The only inputs are the
// snapshot's bytes and the files in this repository.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_SIZE, boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import type { BoardRow, RadarData } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's text cap: the same value the gate rebuilds it with. */
const TEXT_MAX_BYTES = 65_536;

/**
 * The scorer's own limits, checked here first so a bad run fails with a useful sentence rather
 * than at the gate. The image band is the brief's: 300 to 350 KB each, because three images at the
 * 512 KiB gate cap would blow the dossier's 1.5 MiB budget. `view` names the three views the judge
 * expects, so a renamed file cannot silently ship the wrong shots.
 */
const LIMITS = {
  screenshots: {
    min: 3,
    max: 4,
    max_bytes: 512 * 1024,
    min_bytes: 300 * 1024,
    ideal_max_bytes: 350 * 1024,
    long_side: 1440,
    short_sides: [900, 1000],
  },
  dashboard: { max_files: 400, max_bytes: 4 * 1024 * 1024 },
  board: { min: 100, max: 4000, max_bytes: 8 * 1024 * 1024 },
};

/** The three views a judge needs to see: the board, a detail drawer, a filtered board. */
const REQUIRED_SHOTS = ['1-board.png', '2-detail.png', '3-filtered.png'];

/** A file name the gate and the dossier both accept. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** A PNG's first eight bytes. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A PNG's pixel dimensions, read from its IHDR chunk without a decoder: width and height are two
 * big-endian 32-bit words at byte 16. Returns null for a file that is not a PNG.
 */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** `--name value` or `--name=value` out of the arguments, else the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

/** Say why a run cannot continue and stop with the scorer's failure code. */
function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

/** Notes that do not stop the run but should reach the person reading its output. */
const warnings: string[] = [];
function warn(message: string): void {
  warnings.push(message);
}

/** Bytes as a readable size, matching the brief's 1024-based KB. */
function kib(n: number): string {
  return `${Math.round(n / 102.4) / 10} KB`;
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile) || !statSync(inputFile).isFile()) {
  fail(`no snapshot at ${inputFile}; pass --input <snapshot.json|directory> or mount the sealed /input`);
}
const outputDir = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// A development run that leaves the dossier out, so the page can be served and screenshotted before
// the images exist. The graded run never passes it; the printed line says what was skipped.
const draft = process.argv.includes('--draft');

// ---------------------------------------------------------------- the board

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);

if (board.length < LIMITS.board.min || board.length > BOARD_SIZE) {
  fail(`the model produced ${board.length} rows; the board must hold 100 to ${BOARD_SIZE}`);
}
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model produced a board the gate refuses: ${issue}`);

const boardJson = `${JSON.stringify({ rows: board })}\n`;
if (Buffer.byteLength(boardJson) > LIMITS.board.max_bytes) fail(`board.json is over ${LIMITS.board.max_bytes} bytes`);

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), boardJson);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

/**
 * The files on disk are the contract, not the objects still in memory. Read both back, parse the
 * page's script the way a browser would, and refuse to hand in a pair that disagrees: a silent
 * ordering or encoding bug between board.json and data.js would otherwise reach the judge, who
 * compares the screenshots against the code.
 */
function verifyWrittenBoard(written: string, pageText: string): { rows: number; live: number } {
  let parsed: { rows?: BoardRow[] };
  try {
    parsed = JSON.parse(written) as { rows?: BoardRow[] };
  } catch (error) {
    return fail(`board.json is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed.rows)) return fail('board.json holds no rows array');
  const diskIssue = boardIssue(parsed.rows, snapshot);
  if (diskIssue !== null) return fail(`board.json on disk fails the gate's own rules: ${diskIssue}`);

  const prefix = 'window.RADAR=';
  const trimmed = pageText.trimEnd();
  if (!pageText.startsWith(prefix) || !trimmed.endsWith(';')) return fail('data.js is not the script the page expects');
  let page: RadarData;
  try {
    page = JSON.parse(trimmed.slice(prefix.length, -1)) as RadarData;
  } catch (error) {
    return fail(`data.js does not parse: ${(error as Error).message}`);
  }

  if (page.rows.length !== parsed.rows.length) {
    return fail(`data.js carries ${page.rows.length} rows but board.json carries ${parsed.rows.length}`);
  }
  for (let i = 0; i < parsed.rows.length; i++) {
    const boardRow = parsed.rows[i]!;
    const pageRow = page.rows[i]!;
    if (pageRow.slug !== boardRow.slug || pageRow.rank !== boardRow.rank || pageRow.implied_value_usd !== boardRow.implied_value_usd) {
      return fail(`data.js row ${i + 1} (${pageRow.slug} #${pageRow.rank}) disagrees with board.json (${boardRow.slug} #${boardRow.rank})`);
    }
    if (pageRow.farm_steps.length !== boardRow.farm_steps.length) {
      return fail(`data.js row ${i + 1} (${pageRow.slug}) lost part of its farm plan`);
    }
  }
  if (page.stats.board_size !== parsed.rows.length) {
    return fail(`data.js claims ${page.stats.board_size} ranked rows; board.json holds ${parsed.rows.length}`);
  }
  const ranked = new Set(parsed.rows.map((row) => row.slug));
  const leaked = page.live.filter((row) => ranked.has(row.slug));
  if (leaked.length > 0) {
    return fail(`${leaked.length} live-token protocol${leaked.length === 1 ? '' : 's'} also appears on the board, starting with ${leaked[0]!.slug}`);
  }
  return { rows: page.rows.length, live: page.live.length };
}

const written = verifyWrittenBoard(readFileSync(join(outputDir, 'board.json'), 'utf8'), readFileSync(join(outputDir, 'data.js'), 'utf8'));

// ---------------------------------------------------------------- the static page

/**
 * Copy a repository directory's regular files into `to`, recursively, skipping dot names. Returns
 * the relative paths written. A missing source directory is an empty list, not an error: the
 * caller decides whether that is fatal.
 */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from) || !statSync(from).isDirectory()) return [];
  const written: string[] = [];
  const walk = (source: string): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(source, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) fail(`${path} is neither a file nor a directory`);
      const rel = relative(from, path).split(sep).join('/');
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      if (!PLAIN_NAME.test(name)) fail(`${path}: the name must be letters, digits and . _ -, 1 to 128 characters`);
      mkdirSync(join(to, rel.slice(0, Math.max(0, rel.lastIndexOf('/')))), { recursive: true });
      copyFileSync(path, join(to, rel));
      written.push(rel);
    }
  };
  mkdirSync(to, { recursive: true });
  walk(from);
  return written.sort();
}

// A fresh page and image directory each run: stale files from an older build must never leak into
// the dossier the gate compares byte for byte.
const outDashboard = join(outputDir, 'dashboard');
const outScreenshots = join(outputDir, 'screenshots');
rmSync(outDashboard, { recursive: true, force: true });
rmSync(outScreenshots, { recursive: true, force: true });

const dashFiles = copyTree(join(HERE, 'dashboard'), outDashboard);
const shots = copyTree(join(HERE, 'screenshots'), outScreenshots);

if (!dashFiles.includes('index.html')) fail('dashboard/index.html is missing');
if (!dashFiles.some((f) => f.endsWith('.css'))) fail('the dashboard has no stylesheet');
if (!dashFiles.some((f) => f.endsWith('.js'))) fail('the dashboard has no script');
if (dashFiles.length > LIMITS.dashboard.max_files) fail(`the dashboard holds ${dashFiles.length} files`);
let dashBytes = 0;
for (const rel of dashFiles) dashBytes += statSync(join(outDashboard, rel)).size;
if (dashBytes > LIMITS.dashboard.max_bytes) fail(`the dashboard's files come to ${dashBytes} bytes`);

if (shots.length < LIMITS.screenshots.min || shots.length > LIMITS.screenshots.max) {
  if (!(draft && shots.length === 0)) {
    fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}; hand in 3: the board, a detail view and a filtered view`);
  }
}
for (const rel of shots) {
  const bytes = readFileSync(join(outScreenshots, rel));
  const size = pngSize(bytes);
  if (size === null) fail(`screenshots/${rel} is not a PNG`);
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height);
  if (long !== LIMITS.screenshots.long_side || !LIMITS.screenshots.short_sides.includes(short)) {
    fail(
      `screenshots/${rel} is ${size.width}×${size.height}; the judge reads a ${LIMITS.screenshots.long_side}px-wide image at ${LIMITS.screenshots.short_sides.join(' or ')}px tall`,
    );
  }
  if (bytes.length > LIMITS.screenshots.max_bytes) {
    fail(`screenshots/${rel} is ${kib(bytes.length)}, over the ${kib(LIMITS.screenshots.max_bytes)} gate cap`);
  }
  if (bytes.length > LIMITS.screenshots.ideal_max_bytes) {
    warn(`screenshots/${rel} is ${kib(bytes.length)}; trim it under ${kib(LIMITS.screenshots.ideal_max_bytes)} so three fit the dossier`);
  } else if (bytes.length < LIMITS.screenshots.min_bytes) {
    fail(`screenshots/${rel} is ${kib(bytes.length)}, under the ${kib(LIMITS.screenshots.min_bytes)} the brief asks for`);
  }
}

if (!draft) {
  for (const name of REQUIRED_SHOTS) {
    if (!shots.includes(name)) fail(`screenshots/ has no ${name}; the judge expects the board, a detail view and a filtered view`);
  }
  const total = shots.reduce((sum, rel) => sum + statSync(join(outScreenshots, rel)).size, 0);
  if (total > 1536 * 1024) fail(`the screenshots come to ${kib(total)}, over the dossier's 1.5 MiB image budget`);
}

// ---------------------------------------------------------------- the dossier

// Written last, from the finished output directory: the gate rebuilds it from /output and compares.
if (!draft) {
  writeFileSync(join(outputDir, 'dossier.json'), buildDossier(outputDir, { text_max_bytes: TEXT_MAX_BYTES }));
}

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${radar.stats.pre_token_total} pre-token, ${radar.stats.live_total} live token\n` +
    `token radar: ${board.length} rows ranked (${radar.stats.below_floor} below the $${Math.round(snapshot.floor_usd / 1e6)}M floor, ${radar.stats.watchlist_covered}/${radar.stats.watchlist_total} watchlist covered)\n` +
    `token radar: board.json ${kib(Buffer.byteLength(boardJson))}, data.js ${kib(Buffer.byteLength(dataScript(radar)))}, dashboard ${kib(dashBytes)} in ${dashFiles.length} files, ${shots.length} screenshots${draft ? ', dossier skipped (draft)' : `, dossier ${kib(statSync(join(outputDir, 'dossier.json')).size)}`}\n` +
    `token radar: integrity: board.json and data.js agree on ${written.rows} ranked rows and ${written.live} live-token rows\n`,
);

for (const message of warnings) process.stdout.write(`token radar: note: ${message}\n`);
