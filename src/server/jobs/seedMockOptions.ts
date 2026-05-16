import { openDb, migrate } from '../storage/db';
import { insertOptions25Delta, type Options25DeltaRow } from '../storage/repository';

// Hand-curated anchor points based on the reference chart shape.
// All series share the same anchor dates so values align across metrics.
const ANCHOR_DATES = [
  '2021-01-04',
  '2021-07-01',
  '2022-01-03',
  '2022-03-07',  // Russia/Ukraine
  '2022-09-26',
  '2023-03-13',
  '2023-10-30',
  '2024-01-02',
  '2024-04-15',
  '2024-08-05',  // August 2024 vol spike
  '2024-11-15',
  '2025-01-06',
  '2025-04-07',  // 2025 tariff scare
  '2025-07-15',
  '2025-10-15',
  '2026-01-15',
  '2026-05-15',  // ~today, leave one trading day for real data tomorrow
];

// Values approximate the shapes in the reference image (~roughly).
// SPX values are in IV percent (12 = 12% IV).
const SPX_CALL_IV = [12, 11, 14, 22, 18, 14, 13, 12, 13, 22, 13, 13, 23, 16, 12, 14, 15];
const SPX_PUT_IV  = [19, 17, 21, 30, 26, 20, 19, 17, 19, 30, 18, 19, 32, 22, 18, 19, 20];

// VIX option IVs — reference chart shows scale 0.28–0.36; replicate that.
// Note: VIX has positive skew (calls > puts), opposite of SPX.
const VIX_CALL_IV = [0.32, 0.33, 0.31, 0.33, 0.32, 0.31, 0.32, 0.32, 0.32, 0.34, 0.32, 0.32, 0.33, 0.33, 0.32, 0.32, 0.32];
const VIX_PUT_IV  = [0.30, 0.32, 0.30, 0.31, 0.31, 0.30, 0.31, 0.30, 0.30, 0.32, 0.30, 0.30, 0.30, 0.32, 0.30, 0.30, 0.30];

// Deterministic PRNG for reproducibility
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

/** Linearly interpolate between anchors weekly, with small additive noise. */
function generateWeeklyTimeSeries(
  dates: string[],
  values: Series,
  noiseAmplitude: number,
  seed: number,
): Array<{ date: string; value: number }> {
  if (dates.length !== values.length) throw new Error('dates/values length mismatch');
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
      const jitter = (rng() - 0.5) * 2 * noiseAmplitude;
      const d = new Date(aDate.getTime() + w * 7 * 86_400_000);
      out.push({
        date: d.toISOString().slice(0, 10),
        value: Math.max(0, interp + jitter),
      });
    }
  }
  // include the very last anchor
  out.push({ date: dates[dates.length - 1], value: values[values.length - 1] });
  return out;
}

function buildRows(
  underlying: 'SPX' | 'VIX',
  callValues: Series,
  putValues: Series,
  noise: number,
  baseSeed: number,
): Options25DeltaRow[] {
  const calls = generateWeeklyTimeSeries(ANCHOR_DATES, callValues, noise, baseSeed);
  const puts = generateWeeklyTimeSeries(ANCHOR_DATES, putValues, noise, baseSeed + 1);
  // Align by index (same dates by construction)
  if (calls.length !== puts.length) throw new Error(`length mismatch ${calls.length} vs ${puts.length}`);
  return calls.map((c, i) => ({
    underlying,
    snapshotDate: c.date,
    callIv: c.value,
    putIv: puts[i].value,
    skew: puts[i].value - c.value,
    isMock: true,
  }));
}

export async function seedMockOptions(): Promise<void> {
  const db = openDb();
  try {
    migrate(db);
    const spxRows = buildRows('SPX', SPX_CALL_IV, SPX_PUT_IV, 1.5, 42);
    const vixRows = buildRows('VIX', VIX_CALL_IV, VIX_PUT_IV, 0.015, 1337);
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
