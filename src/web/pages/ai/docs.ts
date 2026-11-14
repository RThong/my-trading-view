// 「AI」视角各 regime tab 的 ChartDoc(合进 pages/regimeDims 的 REGIME_DOCS)。
import type { RegimeDocs } from '../../views/regime/regimeChart.hooks';
import { curveHistoryDoc } from '../curveHistory';
import { AI_CDS } from '../../../shared/rateCurveDefs';

// compute dim 四条 GPU 指数共用的署名(License 要求),四格各写一遍会改一处漏一处。
const CGI_ATTRIBUTION = '数据:Computable(getcomputable.com),公开 REST 无需鉴权,CC BY-NC 4.0。';
// CoreWeave 是 H100/H200/B200 三条的 panel 成员 —— 拿这几格跟 CRWV 股价对比时不是两个独立信号。
// 抽成常量而不是逐格手写:用户一次只 hover 一格,漏哪格哪格就没这个提醒(B200 曾漏过,而它偏偏
// 是唯一在 desc 里主动点 CRWV 的一格)。
const CGI_CRWV_CAVEAT = '⚠️ CoreWeave 同时是本条 panel 成员,和 CRWV 股价对比时非完全独立。';
// 这份数据最要紧的方法论限制,四格都要有 —— 同上,用户一次只 hover 一格。
// 拿其中任一格当"成交价"读会直接误判价格趋势,比 CRWV 那条更不能漏。
const CGI_LIST_PRICE_CAVEAT = '⚠️ 是"公开挂牌价"聚合,不是实际成交价——大多数 provider 报的是 list price。';

export const AI_DOCS = {
  // GPU 算力租赁价(Computable GPU Index,CGI):H100/H200/B200 三条核心 + B300 experimental。
  // 免鉴权公开 REST,观测点按日(UTC)聚合成 period rate(粒度由源决定且变过,见 fetchers/computableGpu.ts);
  // 保留窗口只有十几到三十天,暂看不了跨年趋势。
  // 口径提醒:这是「公开挂牌价指数」不是「成交价」——多数 provider 报的是 list price,
  // 只有 Vast.ai/Lium 是真实可交易 ask book;CoreWeave 同时是 H100/H200/B200 panel 成员,
  // 拿这几条跟 CRWV 股价对比时不是完全独立的两个信号。License: CC BY-NC 4.0。
  compute: {
    v: 1,
    panes: [
      {
        id: 'p1',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l1',
            series: 'gpuH100',
            scale: 'right',
            color: '#38bdf8',
            title: 'GPU 算力租赁价 · H100 (Computable GPU Index)',
          },
        ],
        desc: [
          '定义:H100(SXM)GPU 云租赁价格指数,USD/GPU-hour。16 家 provider 加权聚合。',
          '存量算力的基准价,覆盖最广,H100/H200/B200 三条里最先看这条。',
          '',
          CGI_LIST_PRICE_CAVEAT,
          CGI_CRWV_CAVEAT,
          CGI_ATTRIBUTION,
        ].join('\n'),
      },
      {
        id: 'p2',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l2',
            series: 'gpuH200',
            scale: 'right',
            color: '#a78bfa',
            title: 'GPU 算力租赁价 · H200 (Computable GPU Index)',
          },
        ],
        desc: [
          '定义:H200(SXM)GPU 云租赁价格指数,USD/GPU-hour。13 家 provider 加权聚合。',
          '相对 H100 的显存/带宽溢价读法:跟 H100 那条价差比绝对值更有信息量。',
          '',
          CGI_LIST_PRICE_CAVEAT,
          CGI_CRWV_CAVEAT,
          CGI_ATTRIBUTION,
        ].join('\n'),
      },
      {
        id: 'p3',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l3',
            series: 'gpuB200',
            scale: 'right',
            color: '#fb923c',
            title: 'GPU 算力租赁价 · B200 (Computable GPU Index)',
          },
        ],
        desc: [
          '定义:B200(Blackwell)GPU 云租赁价格指数,USD/GPU-hour。9 家 provider 加权聚合。',
          '当前主力集群建设/frontier workload 的代表型号,跟 NVDA/CRWV/VRT 相关性最直接。',
          '',
          CGI_LIST_PRICE_CAVEAT,
          CGI_CRWV_CAVEAT,
          CGI_ATTRIBUTION,
        ].join('\n'),
      },
      {
        id: 'p4',
        stretch: 1,
        scales: [{ id: 'right', side: 'right' }],
        layers: [
          {
            id: 'l4',
            series: 'gpuB300',
            scale: 'right',
            color: '#94a3b8',
            title: 'GPU 算力租赁价 · B300 (Computable GPU Index, experimental)',
          },
        ],
        desc: [
          '定义:B300(Blackwell Ultra)GPU 云租赁价格指数,USD/GPU-hour。仅 8 家 provider,是四条里最薄的。',
          '产品刚商用、报价形成早期的温度计,不是成熟市场价——provider 掉到 5 家以下会停发。',
          '',
          CGI_LIST_PRICE_CAVEAT,
          '⚠️ 标 experimental:样本浅,别当触发告警的核心指标用。',
          CGI_ATTRIBUTION,
        ].join('\n'),
      },
    ],
  },
  // 默认显示 core 的 7 家(与服务端 AI_CDS 的 core 同一份名单:core 缺失会让每日 job 告警);
  // Broadcom / Dell / Intel 较次要,CoreWeave(~1000bp)/ SpaceX(~200bp)/ 软银(~500bp)量级会把其余几家压扁,在图例里按需点开
  aiCds: curveHistoryDoc({
    family: 'cds',
    shown: AI_CDS.filter((c) => c.core).map((c) => c.name),
    desc: [
      '定义:AI 资本开支巨头 + 甲骨文 + 新云 CoreWeave + SpaceX 的 5Y 单名 CDS 利差(bp)时间走势。',
      '数据:ICE Clear Credit 免费 EOD 结算价,由合约价按标准 CDS 定价(回收率 40%、违约强度恒定)反解成约定 spread,约 ±10~15bp(CoreWeave 为 500bp 票息档)。',
      '利差越高 = 市场定价的违约风险越大;甲骨文因 AI 举债显著高于同类,是 AI 信用风险风向标。',
      '更早的历史(ICE 2026-07-24 起才开始存;CoreWeave 2026-10-15、SpaceX 2026-10-20 起)用 DTCC 公开的成交价补:当天各笔成交的中位数,没成交的日子空着。只补成交够密的那段(之后每个月都至少 8 天有成交),所以各家起点不同:Oracle 2025-08 起,多数 2026 年初到年中起,Apple 不补。和 ICE 重叠期逐日对过,多数公司每天差 1bp 上下;CoreWeave 噪音明显大(约 1%)。',
      'CoreWeave(默认隐藏,~1000bp 量级会压扁其余几家)= 租算力给巨头、自己举债买卡的新云,信贷型脆弱的前线。',
      'SpaceX(默认隐藏,~200bp 量级)= FT 报道 AI 对冲盘集中买 CDS 的七家之一。',
      'SoftBank (JPY)(默认隐藏,~500bp 量级)= OpenAI / Stargate 背后的最大举债方。ICE 不清算日本名字,改用 DTCC 公开的成交价:当天各笔成交的中位数,没成交的日子空着(2026 年约六成工作日有点,2025 年约三成)。⚠️ 是日元计价合约(回收率 35%、日元利率换算):比同一家的美元 CDS 读数偏低,和美元那几家比水平时打个折扣,比走势不受影响。',
      '纵轴从 0 起(对齐常见 CDS 图):高度比例 = 真实幅度,不被自动缩放放大。',
    ].join('\n'),
    zeroBase: true,
  }),
} satisfies RegimeDocs;
