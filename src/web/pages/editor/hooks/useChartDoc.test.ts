import { expect, test } from 'bun:test';
import { addLayer, EMPTY_DOC } from '../../../views/chartDoc/chartDoc';
import { parseSaved } from './useChartDoc';

test('parseSaved:没有存档 / 坏 JSON / 校验不过都当空图,合法的原样还原', () => {
  expect(parseSaved(null)).toEqual(EMPTY_DOC);
  expect(parseSaved('{"v":1,"panes":[{"bad')).toEqual(EMPTY_DOC);
  expect(parseSaved('{"v":2,"panes":[]}')).toEqual(EMPTY_DOC);
  const doc = addLayer(EMPTY_DOC, 'SPY', '#111111');
  expect(parseSaved(JSON.stringify(doc))).toEqual(doc);
});
