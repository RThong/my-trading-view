// 锚点插件:画线时「鼠标落在哪 → 锚点存成什么」这一步的横向增强(磁吸等),插件形式接入,画线工具与 useDrawings 不认识具体插件。
// 扩展点清单见 docs/chart-editor-design.md §5.3。
import type { LucideIcon } from 'lucide-react';
import type { BarValues } from '../../../chart/magnet';
import type { DrawingPoint } from '../../../views/chartDoc/chartDoc';

/** 插件拿得到的上下文。一次带全,以后的锚点插件(锁角度、吸整数价位……)不用再改核心 */
export type PointCtx = {
  /** 光标在这一格里的像素(绘图区左上角为原点) */
  x: number;
  y: number;
  /** 光标所在那一根(所属图层的 series):日期 + 可吸的值;那里没数据 = null */
  bar: BarValues | null;
  /** 数值 → 这一格的纵坐标(按所属图层的轴,对数 / 倒轴都对) */
  toY: (v: number) => number | null;
  /** 这条线另一个已定的端点(画趋势线第二点、拖一端时);画第一点 / 拖整条时为 null */
  anchor: DrawingPoint | null;
  /** 按着 Shift */
  shift: boolean;
  /** 这条线只用日期(竖线):纵向高度对它没意义,吸附类插件只对齐日期、不看光标离值多近 */
  onlyTime: boolean;
};

export type PointPlugin = {
  id: string;
  name: string;
  icon: LucideIcon;
  /** 开着时的几种模式(工具栏小三角里选),第一个是默认 */
  modes: { id: string; name: string; hint: string }[];
  /** 纯函数:锚点进、锚点出。不碰文档、不画东西 */
  apply: (p: DrawingPoint, ctx: PointCtx, mode: string) => DrawingPoint;
};

/** 各插件开没开、用哪种模式(按插件 id) */
export type PluginSettings = Record<string, { on: boolean; mode: string }>;
