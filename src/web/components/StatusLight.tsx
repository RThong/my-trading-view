import { useEffect, useState } from 'react';
import type { JobStatus, HealthResponse } from '../../shared/types';

type Tone = 'green' | 'yellow' | 'red' | 'gray';

function overallTone(jobs: JobStatus[]): Tone {
  if (jobs.length === 0) return 'gray';
  if (jobs.some(j => j.status === 'failed')) return 'red';
  if (jobs.some(j => j.status === 'partial')) return 'yellow';
  if (jobs.every(j => j.status === 'success')) return 'green';
  return 'gray';
}

const toneClass: Record<Tone, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
  gray: 'bg-neutral-600',
};

export function StatusLight() {
  const [jobs, setJobs] = useState<JobStatus[]>([]);

  useEffect(() => {
    // 低频轮询:dashboard 开着一整天,cron 跑完后状态灯能自动转绿,不必手动刷页面。
    const load = () => fetch('/api/health').then(r => r.json() as Promise<HealthResponse>).then(data => setJobs(data.jobs));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const tone = overallTone(jobs);
  const title = jobs.length === 0
    ? 'No job runs recorded'
    : jobs.map(j => `${j.name}: ${j.status}${j.error ? ` (${j.error})` : ''}`).join(' | ');

  return (
    <span
      title={title}
      className={`inline-block h-3 w-3 rounded-full ${toneClass[tone]}`}
      aria-label={`Job health: ${tone}`}
    />
  );
}
