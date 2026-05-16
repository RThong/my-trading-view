import { openDb, migrate } from '../storage/db';
import { insertOptions25Delta, type Options25DeltaRow } from '../storage/repository';

// Hand-curated anchors driving the mock 25-delta IV time series.
// The key insight from the prior (too-flat) iteration: don't anchor call/put
// independently — that gives a near-constant skew. Instead anchor (atm_iv,
// skew) separately, then derive:
//   call_iv = atm_iv - skew/2
//   put_iv  = atm_iv + skew/2
// This way the skew curve has its own event-driven shape (spikes around SVB,
// Aug 5 2024, 2025 tariffs) and isn't dragged along by absolute IV moves.

const ANCHOR_DATES = [
  '2021-01-04',
  '2021-04-01',
  '2021-07-01',
  '2021-10-15',
  '2022-01-03',
  '2022-03-07',  // Russia/Ukraine
  '2022-06-15',
  '2022-09-26',
  '2022-12-15',
  '2023-03-13',  // SVB / banking stress
  '2023-06-15',
  '2023-10-30',
  '2024-01-02',
  '2024-04-15',
  '2024-08-05',  // August 2024 vol shock
  '2024-09-15',
  '2024-11-15',
  '2025-01-06',
  '2025-04-07',  // 2025 tariff scare
  '2025-07-15',
  '2025-10-15',
  '2026-01-15',
  '2026-05-15',  // ~today
];

// ── SPX (values in IV percent: 17 = 17% IV) ───────────────────────────────
// ATM IV: where overall vol level sits. Spikes during macro stress.
const SPX_ATM = [
  16, 17, 14, 16, 18, 26, 24, 22, 19,
  19, 16, 17, 14, 16, 26, 18, 15, 16,
  28, 18, 15, 17, 17,
];
// SKEW: put_iv − call_iv premium. Event-driven, mostly 3–8 with sharp peaks.
// IMPORTANT: 2026-05-15 anchor = 3 (matches reference image's labeled value).
const SPX_SKEW = [
  7, 9, 6, 7, 8, 4, 5, 6, 7,
  12, 6, 7, 5, 8, 13, 7, 5, 6,
  15, 6, 4, 4, 3,
];

// ── VIX (values in IV "ratio" matching reference's 0.28–0.36 scale) ───────
// VIX has positive skew (call > put), so its skew is negative.
const VIX_ATM = [
  0.32, 0.32, 0.32, 0.32, 0.31, 0.32, 0.32, 0.32, 0.32,
  0.31, 0.32, 0.32, 0.32, 0.32, 0.33, 0.32, 0.32, 0.32,
  0.32, 0.33, 0.32, 0.32, 0.31,
];
const VIX_SKEW = [
  -0.02, 0.005, -0.01, -0.015, -0.02, 0.005, -0.01, -0.02, -0.02,
  -0.01, -0.01, -0.015, -0.02, -0.015, -0.03, -0.02, -0.02, -0.02,
  -0.035, -0.01, -0.02, -0.02, -0.014,
];

// Deterministic PRNG for reproducible mock data.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Series = number[];

/**
 * Linear interpolation between anchors with weekly granularity + uniform
 * additive noise. Anchor points themselves are emitted exactly (no noise
 * applied to anchors), so the final anchor value is exactly preserved.
 */
function interpolateWeekly(
  dates: string[],
  values: Series,
  noiseAmp: number,
  seed: number,
): Array<{ date: string; value: number }> {
  if (dates.length !== values.length) throw new Error('dates/values mismatch');
  const rng = mulberry32(seed);
  const out: Array<{ date: string; value: number }> = [];

  for (let i = 0; i < dates.length - 1; i++) {
    const aDate = new Date(dates[i] + 'T00:00:00Z');
    const bDate = new Date(dates[i + 1] + 'T00:00:00Z');
    const a = values[i];
    const b = values[i + 1];
    const totalDays = Math.floor((bDate.getTime() - aDate.getTime()) / 86_400_000);
    const weeks = Math.max(1, Math.floor(totalDays / 7));

    for (let w = 0; w < weeks; w++) {
      const t = w / weeks;
      const interp = a + (b - a) * t;
      // Occasional larger excursions to make the curve look more market-like:
      // 1 in 12 weeks gets ~2x the noise (an "outlier" spike).
      const isOutlier = rng() < 1 / 12;
      const amp = noiseAmp * (isOutlier ? 2.2 : 1);
      const jitter = (rng() - 0.5) * 2 * amp;
      const d = new Date(aDate.getTime() + w * 7 * 86_400_000);
      out.push({
        date: d.toISOString().slice(0, 10),
        value: interp + jitter,
      });
    }
  }
  // Append the final anchor exactly (so the very last point matches the
  // reference's labeled "latest" value with no noise).
  out.push({ date: dates[dates.length - 1], value: values[values.length - 1] });
  return out;
}

function buildRows(
  underlying: 'SPX' | 'VIX',
  atmValues: Series,
  skewValues: Series,
  atmNoise: number,
  skewNoise: number,
  baseSeed: number,
): Options25DeltaRow[] {
  const atm = interpolateWeekly(ANCHOR_DATES, atmValues, atmNoise, baseSeed);
  const skew = interpolateWeekly(ANCHOR_DATES, skewValues, skewNoise, baseSeed + 1);
  if (atm.length !== skew.length) {
    throw new Error(`length mismatch ${atm.length} vs ${skew.length}`);
  }
  return atm.map((a, i) => {
    const s = skew[i].value;
    return {
      underlying,
      snapshotDate: a.date,
      callIv: a.value - s / 2,
      putIv: a.value + s / 2,
      skew: s,
      isMock: true,
    };
  });
}

export async function seedMockOptions(): Promise<void> {
  const db = openDb();
  try {
    migrate(db);
    // Larger skew noise relative to baseline gives the chaotic week-to-week
    // wobble visible in the reference chart.
    const spxRows = buildRows('SPX', SPX_ATM, SPX_SKEW, 1.5, 2.0, 42);
    const vixRows = buildRows('VIX', VIX_ATM, VIX_SKEW, 0.005, 0.008, 1337);
    insertOptions25Delta(db, spxRows);
    insertOptions25Delta(db, vixRows);
    console.log(`Inserted ${spxRows.length} SPX + ${vixRows.length} VIX mock 25-delta rows.`);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await seedMockOptions();
}
