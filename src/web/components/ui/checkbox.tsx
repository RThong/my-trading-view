import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from '@web/lib/utils';
import { CheckIcon } from 'lucide-react';

// 相对 shadcn 原版的改动:
// - dark: 拍平成基础类(原因见 button.tsx 顶部)。
// - 禁用态用 data-disabled:Base UI 的 Root 渲染成 <span role="checkbox">,span 匹配不到 :disabled。
// - 去掉 after: 扩大的点击热区:会伸进相邻行,点行边缘会勾到下一行(外面本来就包着 label,点文字也能勾)。
// - 边框提亮到 neutral-600:默认 border-input(neutral-800)在弹层底色 neutral-900 上几乎看不见。
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-neutral-600 transition-colors outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-neutral-600 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:ring-3 aria-invalid:aria-checked:border-primary bg-input/30 aria-invalid:border-destructive/50 aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary data-checked:bg-primary',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
