import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { archiveRuns } from '../fetchers/snapshotArchive';
import { parseMarketsDiary } from '../fetchers/wsjMarketsDiary';
import { ingestArchivedBreadth, isClosedDiary, lagOf } from './breadthSnapshot';
import { adLine } from '../analytics/regime';

// 2026-11-20 实抓的载荷(删掉了没用到的版块)
const SAMPLE = {
  data: {
    timestamp: '4:15 PM EST 11/20/26',
    instrumentSets: [
      {
        headerFields: [{ value: 'name', label: 'Issues' }],
        instruments: [
          { name: 'Advancing', NASDAQ: '967', NYSE: '541' },
          { name: 'Declining', NASDAQ: '4,049', NYSE: '2,197' },
          { name: 'Unchanged', NASDAQ: '158', NYSE: '46' },
          { name: 'Total', NASDAQ: '5,174', NYSE: '2,784' },
        ],
      },
      {
        headerFields: [{ value: 'name', label: 'Issues At' }],
        instruments: [
          { name: 'New Highs', NASDAQ: '40', NYSE: '13' },
          { name: 'New Lows', NASDAQ: '700', NYSE: '564' },
        ],
      },
      {
        headerFields: [{ value: 'name', label: 'Share Volume' }],
        instruments: [
          { name: 'Total', NASDAQ: '9', NYSE: '6,804,244,393' },
          { name: 'Advancing', NASDAQ: '3', NYSE: '1,350,901,891' },
          { name: 'Declining', NASDAQ: '6', NYSE: '5,390,796,339' },
        ],
      },
    ],
  },
};

test('parseMarketsDiary:按版块名 + 行名取数,去千分位', () => {
  const d = parseMarketsDiary(SAMPLE);

  expect(d.date).toBe('2026-11-20');
  expect(d.nyse).toEqual({
    adv: 541,
    dec: 2197,
    unch: 46,
    newHighs: 13,
    newLows: 564,
    advVol: 1350901891,
    decVol: 5390796339,
  });
  expect(d.nasdaq.dec).toBe(4049);
});

test('parseMarketsDiary:缺行 / 时间戳认不出就抛错,不写 0', () => {
  const noLows = structuredClone(SAMPLE);
  noLows.data.instrumentSets[1]!.instruments.pop();
  expect(() => parseMarketsDiary(noLows)).toThrow('New Lows');

  const badTs = structuredClone(SAMPLE);
  badTs.data.timestamp = 'Nov 20, 2026';
  expect(() => parseMarketsDiary(badTs)).toThrow('timestamp');
  badTs.data.timestamp = '4:15 PM EST 13/40/26';
  expect(() => parseMarketsDiary(badTs)).toThrow('不存在');

  // 空串 / 科学计数 / 涨家数为 0 都不能当数写进去
  const bad = (v: string) => {
    const d = structuredClone(SAMPLE);
    d.data.instrumentSets[0]!.instruments[0]!.NYSE = v;
    return () => parseMarketsDiary(d);
  };
  ['', ' ', '1e3', '1,,000', '0'].forEach((v) => {
    expect(bad(v)).toThrow('Advancing');
  });
});

test('isClosedDiary:判现在几点,不看时间戳(半日市不误判)', () => {
  // 2026-11-20 是 EST(UTC−5)
  expect(isClosedDiary('2026-11-20', new Date('2026-11-20T19:00:00Z'))).toBe(false); // ET 14:00 盘中
  expect(isClosedDiary('2026-11-20', new Date('2026-11-20T22:00:00Z'))).toBe(true); // ET 17:00
  expect(isClosedDiary('2026-11-20', new Date('2026-11-21T02:00:00Z'))).toBe(true); // JST 11 点那轮
  expect(isClosedDiary('2026-11-19', new Date('2026-11-20T15:00:00Z'))).toBe(true); // 盘中,但还是前一天那份
  expect(isClosedDiary('2026-11-23', new Date('2026-11-21T02:00:00Z'))).toBe(false); // 未来日期 = 源出错
});

test('adLine:按日期配对累加,缺一腿的那天跳过', () => {
  const adv = [
    { date: 'd1', value: 100 },
    { date: 'd2', value: 50 },
    { date: 'd3', value: 300 },
  ];
  const dec = [
    { date: 'd1', value: 40 },
    { date: 'd3', value: 100 },
  ];

  expect(adLine(adv, dec)).toEqual([
    { date: 'd1', value: 60 },
    { date: 'd3', value: 260 },
  ]);
});

test('lagOf:落后上一收盘日 → lagging,超过 5 个工作日 → stale', () => {
  expect(lagOf('2026-11-20', '2026-11-20')).toEqual({ lagging: false, stale: null });
  expect(lagOf('2026-11-20', '2026-11-23')).toEqual({ lagging: true, stale: null }); // 跨周末只算 1 个工作日
  expect(lagOf('2026-11-13', '2026-11-20').stale).toBeNull(); // 落后 5 个工作日,还不算断
  expect(lagOf('2026-11-12', '2026-11-20').stale).toContain('停在 2026-11-12');
});

test('ingestArchivedBreadth:收盘后抓的写库,盘中抓的跳过,坏文件不挡别的轮', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const put = (run: string, body: unknown) => {
    mkdirSync(join(dir, 'data', run), { recursive: true });
    writeFileSync(join(dir, 'data', run, 'wsj-diary.json.gz'), Bun.gzipSync(JSON.stringify(body)));
  };
  // 11-20 收盘后(ET 17:07)那轮写;11-20 盘中(ET 14:00,值是当天)那轮不写;坏文件跳过
  put('2026-11-20T2207Z', SAMPLE);
  const intraday = structuredClone(SAMPLE);
  intraday.data.timestamp = '2:00 PM EST 11/19/26';
  put('2026-11-19T1900Z', intraday);
  put('2026-11-18T2207Z', { data: {} });

  const db = new Database(':memory:');
  migrate(db);

  expect(ingestArchivedBreadth(db, archiveRuns(dir))).toBe(14);
  expect(getMarketSeries(db, 'WSJ_NYSE_ADV')).toEqual([{ date: '2026-11-20', value: 541 }]);
});

test('ingestArchivedBreadth:库里已有的日子不覆盖(本机后抓的更接近定型值)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(dir, 'data', '2026-11-20T2207Z'), { recursive: true });
  writeFileSync(join(dir, 'data', '2026-11-20T2207Z', 'wsj-diary.json.gz'), Bun.gzipSync(JSON.stringify(SAMPLE)));
  const db = new Database(':memory:');
  migrate(db);
  insertMarketSeries(db, [{ seriesId: 'WSJ_NYSE_ADV', obsDate: '2026-11-20', value: 540 }]);

  expect(ingestArchivedBreadth(db, archiveRuns(dir))).toBe(0);
  expect(getMarketSeries(db, 'WSJ_NYSE_ADV')).toEqual([{ date: '2026-11-20', value: 540 }]);
});
