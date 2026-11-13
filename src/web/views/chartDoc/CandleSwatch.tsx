import { SIGNED_DOWN, SIGNED_UP } from '../../chart/palette';
import { cn } from '../../lib/utils';

// 蜡烛图层的色块:涨绿跌红各半(图层颜色不起作用,画一个单色块会对不上图上的 K 线)。
// 两半各用纯色底而不是一条渐变:导出图片时图例按元素底色描到画布上(pages/editor/snapshot),认不了渐变
export function CandleSwatch({ className }: { className?: string }) {
  return (
    <span className={cn('flex overflow-hidden rounded-sm', className)} title="蜡烛:涨绿跌红">
      <span className="flex-1" style={{ background: SIGNED_UP }} />
      <span className="flex-1" style={{ background: SIGNED_DOWN }} />
    </span>
  );
}
