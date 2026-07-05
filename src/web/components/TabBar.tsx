type Tab = { id: string; label: string };

type Props = {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  vertical?: boolean;
};

export function TabBar({ tabs, active, onChange, vertical }: Props) {
  return (
    <nav
      className={
        vertical
          ? 'flex flex-col gap-1 border-r border-neutral-800 px-2 py-3'
          : 'flex gap-1 border-b border-neutral-800 px-6 py-2'
      }
    >
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={
            'rounded px-3 py-1.5 text-sm transition-colors ' +
            (t.id === active
              ? 'bg-neutral-700 text-white'
              : 'text-neutral-400 hover:text-white hover:bg-neutral-800')
          }
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
