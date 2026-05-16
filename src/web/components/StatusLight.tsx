import { useEffect, useState } from 'react';
import { api } from '../lib/client';
import type { JobStatus } from '../../shared/types';

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
    api.api.health.$get().then(r => r.json()).then(data => setJobs(data.jobs));
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
