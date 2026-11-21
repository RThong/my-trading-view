// 命令行出图:一份 ChartDoc(JSON 文件,格式同编辑器「查看 JSON / 导入 JSON」)→ PNG,和编辑器里点「导出图片」出来的一模一样。
//   bun run render-chart <doc.json> <out.png> [--interval 1D|1W|1M|1Q|1Y] [--theme light|dark] [--size 1400x800] [--from 2022-12-01]
// 做法:无界面打开本机看板的出图页(/render#doc=…,见 src/web/pages/editor/RenderPage),等它画完、拿回 PNG 写成文件。
// 前提:dev server 开着(bun run dev),取数同平时看板。浏览器用本机装的 Google Chrome(channel: 'chrome'),
// 不另下载 Playwright 自带的 Chromium
import { parseArgs } from 'node:util';
import { type Browser, chromium } from 'playwright';
import { isDate, parseChartDoc } from '../src/web/views/chartDoc/chartDoc';
import { renderHash } from '../src/web/views/chartDoc/docLink';
import { type Interval, INTERVALS } from '../src/web/hooks/interval';

// 同 vite.config 的 WEB_PORT(bun 自动读 .env)
const BASE = `http://localhost:${process.env.WEB_PORT ?? 5173}`;
// 数据从各源现拉,慢的源(如 Yahoo 长历史)十几秒,留足余量
const TIMEOUT_MS = 90_000;
// 2 倍像素(同 Retina 屏上导出的清晰度)。浏览器启动参数和页面的 deviceScaleFactor 都读它,两处不一致就会复发下面那个画布 1 倍 / 2 倍混用的问题:
// 只靠 newPage 的 deviceScaleFactor(模拟)时,无界面 Chrome 报给 ResizeObserver 的 device-pixel 尺寸不可靠 ——
// 图表各块画布有的停在 1 倍、有的(后来改过宽的)变 2 倍,拼出来右轴只有一半大(2026-11-18 实测)。所以启动时也真按这个倍数起
const DPR = 2;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    interval: { type: 'string', default: '1D' },
    theme: { type: 'string', default: 'light' },
    size: { type: 'string', default: '1400x800' },
    // 横轴从这天画起(到最新);不给 = 整段数据
    from: { type: 'string' },
    base: { type: 'string', default: BASE },
  },
});
const [docPath, outPath] = positionals;
if (!docPath || !outPath)
  fail(
    '用法: bun run render-chart <doc.json> <out.png> [--interval 1W] [--theme dark] [--size 1400x800] [--from 2022-12-01]',
  );
if (!INTERVALS.includes(values.interval as Interval)) fail(`--interval 只能是 ${INTERVALS.join(' / ')}`);
if (values.theme !== 'light' && values.theme !== 'dark') fail('--theme 只能是 light / dark');
const [width, height] = values.size.split('x').map(Number);
if (!(width > 0 && height > 0)) fail('--size 写成 宽x高,如 1400x800');
if (values.from !== undefined && !isDate(values.from)) fail('--from 写成 YYYY-MM-DD,如 2022-12-01');

const doc = parseChartDoc(await Bun.file(docPath).json());
if (!doc) fail(`${docPath} 不是合法的 ChartDoc(同编辑器「导入 JSON」的校验)`);

const url = `${values.base}/render#${renderHash(doc, { interval: values.interval as Interval, theme: values.theme, from: values.from })}`;
/** 打开出图页、等它交出结果;出错抛一句话的 Error(浏览器由调用方在 finally 里关,不在这里 exit) */
async function render(browser: Browser): Promise<{ png: string; missing: string[] }> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: DPR });
  await page.goto(url).catch(() => {
    throw new Error(`打不开 ${values.base}:dev server 开着吗(bun run dev)?`);
  });
  const handle = await page
    .waitForFunction(() => (window as { __render?: unknown }).__render, null, { timeout: TIMEOUT_MS })
    .catch(() => {
      throw new Error(`${TIMEOUT_MS / 1000} 秒内没画完:可能某个源卡住了,在看板里打开同一张图看看`);
    });
  const result = (await handle.jsonValue()) as { png: string; missing: string[] } | { error: string };
  if ('error' in result) throw new Error(`出图失败:${result.error}`);

  return result;
}

const browser = await chromium.launch({ channel: 'chrome', args: [`--force-device-scale-factor=${DPR}`] });
// 出错也要先关浏览器再退出:process.exit 不跑 finally,无界面 Chrome 会留在后台
const outcome = await render(browser)
  .then((r) => ({ ok: r }))
  .catch((e: unknown) => ({ err: e instanceof Error ? e.message : String(e) }))
  .finally(() => browser.close());
if ('err' in outcome) fail(outcome.err);

const { png, missing } = outcome.ok;
if (missing.length) console.warn(`警告:这些序列没取到数,图上是空的: ${missing.join(', ')}`);
await Bun.write(outPath, Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'));
console.log(outPath);
