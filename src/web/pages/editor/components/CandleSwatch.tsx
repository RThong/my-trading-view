import { SIGNED_DOWN, SIGNED_UP } from '../../../chart/palette';
import { cn } from '../../../lib/utils';

// 蜡烛图层的色块:涨绿跌红各半(图层颜色不起作用,画一个单色块会对不上图上的 K 线)
export function CandleSwatch({ className }: { className?: string }) {
  return (
    <span
      className={cn('rounded-sm', className)}
      style={{ background: `linear-gradient(90deg, ${SIGNED_UP} 50%, ${SIGNED_DOWN} 50%)` }}
      title="蜡烛:涨绿跌红"
    />
  );
}
