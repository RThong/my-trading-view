// 锚点插件的登记处与管道。加插件 = 新建一个文件 + 在 POINT_PLUGINS 里加一项;核心(useDrawings、工具栏)不用改。
import { useState } from 'react';
import type { DrawingPoint } from '../../../views/chartDoc/chartDoc';
import { magnet } from './magnet';
import type { PluginSettings, PointCtx, PointPlugin } from './types';

/** 顺序即执行顺序:关掉其中一个,其余照原顺序走。新插件放第几位要想清楚(先吸附再锁角度 ≠ 先锁角度再吸附) */
export const POINT_PLUGINS: PointPlugin[] = [magnet];

/** 插件当前模式:存档里的值不在插件声明里(改过名 / 手改存档)就用它的第一个 */
export function modeOf(settings: PluginSettings, pl: PointPlugin): string {
  const m = settings[pl.id]?.mode;
  return m && pl.modes.some((x) => x.id === m) ? m : pl.modes[0].id;
}

/** 管道:依次过开着的插件;全关 = 原样返回 */
export function runPlugins(
  p: DrawingPoint,
  ctx: PointCtx,
  settings: PluginSettings,
  plugins: PointPlugin[] = POINT_PLUGINS,
): DrawingPoint {
  return plugins.reduce((pt, pl) => (settings[pl.id]?.on ? pl.apply(pt, ctx, modeOf(settings, pl)) : pt), p);
}

// 开关与模式跨刷新记住(只是偏好,读写失败就全关)
const STORAGE_KEY = 'mtv:drawingPlugins';

function load(): PluginSettings {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function save(s: PluginSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式存不上:本次会话照常 */
  }
}

/** 各插件的开关 / 模式 */
export function usePluginSettings() {
  const [settings, setSettings] = useState(load);

  const update = (id: string, on: boolean, mode: string) => {
    const next = { ...settings, [id]: { on, mode } };
    setSettings(next);
    save(next);
  };

  return {
    settings,
    isOn: (pl: PointPlugin) => !!settings[pl.id]?.on,
    modeOf: (pl: PointPlugin) => modeOf(settings, pl),
    toggle: (pl: PointPlugin) => update(pl.id, !settings[pl.id]?.on, modeOf(settings, pl)),
    /** 选模式顺带打开(同 TradingView:在下拉里选了弱 / 强磁吸就是开着) */
    setMode: (pl: PointPlugin, mode: string) => update(pl.id, true, mode),
  };
}

export type PluginControls = ReturnType<typeof usePluginSettings>;
