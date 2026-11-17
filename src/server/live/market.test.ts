import { describe, expect, it } from 'bun:test';
import { checkedDaily, checkedGaps, shrunk } from './market';

describe('checkedDaily', () => {
  const ok = [
    { date: '2012-01-01', value: 1 },
    { date: '2012-01-02', value: 1 },
  ];

  it('截掉起点前的点', () => {
    expect(checkedDaily('X', [{ date: '2011-12-31', value: 9 }, ...ok], '2012-01-01')).toEqual(ok);
  });

  it('为空 / 不从起点开始 / 中间缺天 → 抛错', () => {
    const cases = [[], [{ date: '2012-01-02', value: 1 }], [ok[0], { date: '2012-01-03', value: 1 }]];
    cases.forEach((bad) => {
      expect(() => checkedDaily('X', bad, '2012-01-01')).toThrow('不完整');
    });
  });
});

describe('shrunk', () => {
  const d = (...dates: string[]) => dates.map((date) => ({ date }));
  const prev = [d('2012-01-01', '2026-11-16')];

  it('首尾都没缩 → 都不算(尾部变长是常态)', () => {
    expect(shrunk([d('2012-01-01', '2026-11-17')], prev)).toEqual({ head: false, tail: false });
  });

  it('首日变晚 / 变空 → head;末日变早 → tail;多条序列任一条缩了就算', () => {
    expect(shrunk([d('2014-09-17', '2026-11-16')], prev).head).toBe(true);
    expect(shrunk([[]], prev).head).toBe(true);
    expect(shrunk([d('2012-01-01', '2026-10-01')], prev)).toEqual({ head: false, tail: true });
    expect(shrunk([d('2012-01-01', '2026-11-16'), d('2012-01-01', '2026-11-01')], [...prev, ...prev]).tail).toBe(true);
  });

  it('没有上一份 → 都不算', () => {
    expect(shrunk([d('2026-01-01')], [[]])).toEqual({ head: false, tail: false });
  });
});

describe('checkedGaps', () => {
  it('相邻隔 7 天放行(9·11 休市那次),超过 7 天 / 空 → 抛', () => {
    const pts = (...dates: string[]) => dates.map((date) => ({ date }));
    expect(checkedGaps('X', pts('2001-09-10', '2001-09-17'))).toHaveLength(2);
    expect(() => checkedGaps('X', pts('2026-01-01', '2026-01-09'))).toThrow('断档');
    expect(() => checkedGaps('X', [])).toThrow('断档');
  });
});
