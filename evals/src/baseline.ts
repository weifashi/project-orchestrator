import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { baselinePath } from './paths.js';
import { DIMENSIONS, type Recording, type Scores } from './recording.js';

export type Baseline = { schema_version: 1; updated_at: string; roles: Record<string, Scores> };

export function readBaseline(): Baseline {
  if (!existsSync(baselinePath)) return { schema_version: 1, updated_at: '', roles: {} };
  return JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
}

export function writeBaseline(baseline: Baseline): void {
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

export function roleMeans(recordings: Recording[]): Scores {
  if (recordings.length === 0) throw new Error('no recordings to average');
  const means = {} as Scores;
  for (const dimension of DIMENSIONS) {
    const total = recordings.reduce((sum, recording) => sum + recording.scores[dimension], 0);
    means[dimension] = Math.round((total / recordings.length) * 100) / 100;
  }
  return means;
}
