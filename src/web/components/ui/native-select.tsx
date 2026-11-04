import type * as React from 'react';
import { cn } from '@web/lib/utils';
import { ChevronDownIcon } from 'lucide-react';

// 相对 shadcn 原版的改动:dark: 拍平成基础类(原因见 button.tsx 顶部);禁用不掐鼠标事件(禁用原因写在 title 里);
// 加 xs 一档(工具条 / 图层卡片里的密集下拉:高 h-5、字号 text-xs,与同一行的 2xs 按钮 / 输入框对齐);
// 自带文字色 text-foreground(不设会继承父级的暗色)。选项用的 Canvas 系统色靠 styles.css 的全站 color-scheme: dark 取深色。
type NativeSelectProps = Omit<React.ComponentProps<'select'>, 'size'> & {
  size?: 'xs' | 'sm' | 'default';
};

function NativeSelect({ className, size = 'default', ...props }: NativeSelectProps) {
  return (
    <div
      className={cn('group/native-select relative w-fit has-[select:disabled]:opacity-50', className)}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className="h-8 w-full min-w-0 appearance-none rounded-lg border border-input py-1 pr-8 pl-2.5 text-sm text-foreground transition-colors outline-none select-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed aria-invalid:ring-3 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] data-[size=sm]:py-0.5 data-[size=xs]:h-5 data-[size=xs]:rounded-md data-[size=xs]:py-0 data-[size=xs]:pr-6 data-[size=xs]:pl-1.5 data-[size=xs]:text-xs bg-input/30 hover:bg-input/50 aria-invalid:border-destructive/50 aria-invalid:ring-destructive/40"
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 group-data-[size=xs]/native-select:right-1.5 group-data-[size=xs]/native-select:size-3 -translate-y-1/2 text-muted-foreground select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<'option'>) {
  return (
    <option data-slot="native-select-option" className={cn('bg-[Canvas] text-[CanvasText]', className)} {...props} />
  );
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<'optgroup'>) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn('bg-[Canvas] text-[CanvasText]', className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
