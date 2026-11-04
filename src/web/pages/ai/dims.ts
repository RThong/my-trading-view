// 「AI」视角各 regime tab 的 pane 配置(合进 pages/regimeDims 的 REGIME_DIMS)。
import type { RegimeDims } from '../../views/regime/regimeChart.hooks';

// compute dim 四条 GPU 指数共用的署名(License 要求),四格各写一遍会改一处漏一处。
const CGI_ATTRIBUTION = '数据:Computable(getcomputable.com),公开 REST 无需鉴权,CC BY-NC 4.0。';
// CoreWeave 是 H100/H200/B200 三条的 panel 成员 —— 拿这几格跟 CRWV 股价对比时不是两个独立信号。
// 抽成常量而不是逐格手写:用户一次只 hover 一格,漏哪格哪格就没这个提醒(B200 曾漏过,而它偏偏
// 是唯一在 desc 里主动点 CRWV 的一格)。
const CGI_CRWV_CAVEAT = '⚠️ CoreWeave 同时是本条 panel 成员,和 CRWV 股价对比时非完全独立。';
// 这份数据最要紧的方法论限制,四格都要有 —— 同上,用户一次只 hover 一格。
// 拿其中任一格当"成交价"读会直接误判价格趋势,比 CRWV 那条更不能漏。
const CGI_LIST_PRICE_CAVEAT = '⚠️ 是"公开挂牌价"聚合,不是实际成交价——大多数 provider 报的是 list price。';

export const AI_DIMS = {
  // GPU 算力租赁价(Computable GPU Index,CGI):H100/H200/B200 三条核心 + B300 experimental。
  // 免鉴权公开 REST,观测点按日(UTC)聚合成 period rate(粒度由源决定且变过,见 fetchers/computableGpu.ts);
  // 保留窗口只有十几到三十天,暂看不了跨年趋势。
  // 口径提醒:这是「公开挂牌价指数」不是「成交价」——多数 provider 报的是 list price,
  // 只有 Vast.ai/Lium 是真实可交易 ask book;CoreWeave 同时是 H100/H200/B200 panel 成员,
  // 拿这几条跟 CRWV 股价对比时不是完全独立的两个信号。License: CC BY-NC 4.0。
  compute: {
    panes: [
      {
        key: 'gpuH100',
        label: 'H100',
        title: 'GPU 算力租赁价 · H100 (Computable GPU Index)',
        color: '#38bdf8',
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
        key: 'gpuH200',
        label: 'H200',
        title: 'GPU 算力租赁价 · H200 (Computable GPU Index)',
        color: '#a78bfa',
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
        key: 'gpuB200',
        label: 'B200',
        title: 'GPU 算力租赁价 · B200 (Computable GPU Index)',
        color: '#fb923c',
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
        key: 'gpuB300',
        label: 'B300 (experimental)',
        title: 'GPU 算力租赁价 · B300 (Computable GPU Index, experimental)',
        color: '#94a3b8',
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
} satisfies RegimeDims;
