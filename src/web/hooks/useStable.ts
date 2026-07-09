import { useRef } from 'react';
import { isDeepEqual } from 'remeda';

// 通用引用稳定化:内容深比较(remeda)未变则复用旧引用,让依赖它的 effect 只在真变化时跑。
// 用途:图表类 hook 的 sync effect 依赖数组入参;调用方每渲染传新数组字面量会让 effect 每帧重跑
// (经 setData/fitContent → ResizeObserver 连锁,轻则弹回缩放,重则无限循环)。
// 稳定化责任放 hook 内部,不甩给调用方。
export function useStable<T>(value: T): T {
  const ref = useRef(value);
  if (!isDeepEqual(ref.current, value)) ref.current = value;
  return ref.current;
}
