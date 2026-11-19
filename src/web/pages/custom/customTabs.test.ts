import { describe, expect, test } from 'bun:test';
import type { ChartDoc } from '../../views/chartDoc/chartDoc';
import { EMPTY_STORE, editTab, parseStore, type CustomStore } from './customTabs';

const DOC: ChartDoc = {
  v: 1,
  panes: [
    {
      id: 'p1',
      stretch: 1,
      scales: [{ id: 'right', side: 'right' }],
      layers: [{ id: 'l1', series: 'SPY', scale: 'right', color: '#3987e5' }],
    },
  ],
};
const STORE: CustomStore = {
  v: 1,
  perspectives: [
    { id: 'p1', label: '我的', tabs: [{ id: 't1', label: '黄金', blocks: [{ id: 'b1', kind: 'chart', doc: DOC }] }] },
  ],
};

describe('parseStore', () => {
  test('完好的存档原样读回', () => {
    expect(parseStore(JSON.parse(JSON.stringify(STORE)))).toEqual(STORE);
  });

  test('不是存档 / 版本不对 → 空', () => {
    expect(parseStore(null)).toEqual(EMPTY_STORE);
    expect(parseStore({ v: 2, perspectives: [] })).toEqual(EMPTY_STORE);
  });

  test('坏的那一项单独丢掉,其余照留', () => {
    const raw = {
      v: 1,
      perspectives: [
        {
          id: 'p1',
          label: '我的',
          tabs: [
            {
              id: 't1',
              label: '黄金',
              blocks: [
                { id: 'b0', kind: 'chart', doc: { v: 9 } },
                // 新建后没点完成就刷新留下的空图
                { id: 'b2', kind: 'chart', doc: { v: 1, panes: [] } },
                STORE.perspectives[0].tabs[0].blocks[0],
              ],
            },
            { id: 't2', blocks: [] },
          ],
        },
        { label: '没有 id' },
      ],
    };

    expect(parseStore(raw)).toEqual(STORE);
  });
});

test('editTab 只改指定的 tab', () => {
  const next = editTab(STORE, 'p1', 't1', (t) => ({ ...t, label: '白银' }));

  expect(next.perspectives[0].tabs[0].label).toBe('白银');
  expect(editTab(STORE, 'p1', 'nope', (t) => ({ ...t, label: 'x' }))).toEqual(STORE);
});
