import type * as React from 'react';
import { cn } from '@web/lib/utils';

// 相对 shadcn 原版的改动:dark: 拍平成基础类(原因见 button.tsx 顶部);md:text-sm 也拍平成 text-sm(只在桌面用,调用方的 text-xs 才盖得住);
// 去掉 field-sizing-content(随内容撑高):要自动撑高的地方自己加,别让固定高度的调用方去抵消它。
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-16 w-full rounded-lg border border-input px-2.5 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 bg-input/30 disabled:bg-input/80 aria-invalid:border-destructive/50 aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
