// 「让用户选一个」的弹窗,用法同 window.confirm 但不卡页面、按钮可以有好几个:
//   const [ask, dialog] = useChoice();  …  const v = await ask({ title, choices, cancel });  …  return <>{dialog}…</>
// Esc 关掉 = 选 cancel。弹窗开着时再 ask 一次,前一个按 cancel 结束(同一时刻只问一件事)。
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { Button } from './ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from './ui/alert-dialog';

type Variant = 'default' | 'outline' | 'ghost' | 'destructive';

export type Ask<T> = {
  title: string;
  description?: string;
  /** 从左到右排;主操作放最后、给 variant 'default' */
  choices: { label: string; value: T; variant?: Variant }[];
  /** Esc 关掉时算选了哪个 */
  cancel: T;
};

type Pending = { ask: Ask<unknown>; resolve: (v: unknown) => void };

export function useChoice(): [<T>(a: Ask<T>) => Promise<T>, ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null);
  // 新的 ask 进来时要结束旧的那个:在回调里读,不依赖渲染
  const pendingRef = useRef<Pending | null>(null);

  const finish = (v: unknown) => {
    pendingRef.current?.resolve(v);
    pendingRef.current = null;
    setPending(null);
  };

  const ask = useCallback(
    <T,>(a: Ask<T>) =>
      new Promise<T>((resolve) => {
        pendingRef.current?.resolve(pendingRef.current.ask.cancel);
        pendingRef.current = { ask: a as Ask<unknown>, resolve: resolve as (v: unknown) => void };
        setPending(pendingRef.current);
      }),
    [],
  );

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && pending && finish(pending.ask.cancel)}>
      {pending && (
        <AlertDialogContent>
          <AlertDialogTitle>{pending.ask.title}</AlertDialogTitle>
          {pending.ask.description && <AlertDialogDescription>{pending.ask.description}</AlertDialogDescription>}
          <AlertDialogFooter>
            {pending.ask.choices.map((c) => (
              <Button key={c.label} variant={c.variant ?? 'outline'} onClick={() => finish(c.value)}>
                {c.label}
              </Button>
            ))}
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );

  return [ask, dialog];
}
