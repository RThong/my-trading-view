// shadcn/ui 的类名合并:clsx 拼条件类名,tailwind-merge 让后面的 Tailwind 类覆盖前面冲突的(组件默认样式 + 调用方 className)。
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
