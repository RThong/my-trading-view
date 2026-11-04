import type * as React from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@web/lib/utils';

// 相对 shadcn 原版的改动:dark: 拍平成基础类(原因见 button.tsx 顶部)、禁用不掐鼠标事件;md:text-sm 也拍平成 text-sm(只在桌面用,调用方的 text-xs 才盖得住)。
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input px-2.5 py-1 text-sm transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 bg-input/30 disabled:bg-input/80 aria-invalid:border-destructive/50 aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
