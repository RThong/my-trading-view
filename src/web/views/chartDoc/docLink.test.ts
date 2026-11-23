import { expect, test } from 'bun:test';
import { addLayer, EMPTY_DOC } from './chartDoc';
import { readRenderHash, renderHash } from './docLink';

test('出图链接:中文标题来回不乱;周期 / 主题带过去,缺省日线、浅色;坏文档报错', () => {
  const doc = { ...addLayer(EMPTY_DOC, 'yh:HG=F', '#2f6fd6'), title: '铜 · 金银比(倒轴)' };
  expect(readRenderHash(`#${renderHash(doc, { interval: '1W', theme: 'dark' })}`)).toEqual({
    doc,
    interval: '1W',
    theme: 'dark',
  });
  const bare = new URLSearchParams(renderHash(doc, { interval: '1W', theme: 'dark' })).get('doc');
  expect(readRenderHash(`doc=${bare}`)).toMatchObject({ interval: '1D', theme: 'light' });
  expect(readRenderHash('')).toHaveProperty('error');
  expect(readRenderHash('doc=not-base64!!')).toHaveProperty('error');
});

test('出图链接的起始日:带过去;不合法的日期报错', () => {
  const doc = addLayer(EMPTY_DOC, 'yh:SPY', '#2f6fd6');
  const hash = renderHash(doc, { interval: '1D', theme: 'light', from: '2022-12-01' });
  expect(readRenderHash(hash)).toMatchObject({ from: '2022-12-01' });
  expect(readRenderHash(hash.replace('2022-12-01', '2022-13-01'))).toHaveProperty('error');
  expect(readRenderHash(renderHash(doc, { interval: '1D', theme: 'light' }))).not.toHaveProperty('from');
});

test('出图链接的截止日与文档可视区:to 带过去、from ≥ to 报错;range 随文档来回,坏的只丢这一项', () => {
  const doc = { ...addLayer(EMPTY_DOC, 'yh:SPY', '#2f6fd6'), range: { from: '1998-10-01', to: '2000-03-31' } };
  const hash = renderHash(doc, { interval: '1D', theme: 'light', from: '1999-01-04', to: '1999-06-30' });
  expect(readRenderHash(hash)).toMatchObject({ doc, from: '1999-01-04', to: '1999-06-30' });
  expect(readRenderHash(hash.replace('1999-06-30', '1998-06-30'))).toHaveProperty('error');

  const bad = { ...doc, range: { from: '2000-03-31', to: '1998-10-01' } };
  const parsed = readRenderHash(renderHash(bad, { interval: '1D', theme: 'light' }));
  expect('doc' in parsed && parsed.doc.range).toBeUndefined();
});
