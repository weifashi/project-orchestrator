import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordingsDir } from './paths.js';

export const DIMENSIONS = ['persona', 'domain', 'context', 'boundary', 'actionability'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Scores = Record<Dimension, number>;

export type Recording = {
  schema_version: 1;
  role: string;
  scenario: string;
  skill_hash: string;
  rubric_hash: string;
  executor_model: string;
  judge_model: string;
  recorded_at: string;
  output_text: string;
  output_envelope: unknown;
  scores: Scores;
  rationale: Record<Dimension, string>;
  hard_gates: { schema_valid: boolean; contract_complete: boolean; forbidden_absent: boolean };
};

const HEX64 = /^[0-9a-f]{64}$/;
const fail = (path: string, message: string): never => { throw new Error(`${path}: ${message}`); };
const str = (o: Record<string, unknown>, key: string, path: string): string =>
  typeof o[key] === 'string' ? (o[key] as string) : fail(path, `${key} must be a string`);

export function parseRecording(value: unknown, path = 'recording'): Recording {
  if (value === null || typeof value !== 'object') return fail(path, 'must be an object');
  const o = value as Record<string, unknown>;
  if (o['schema_version'] !== 1) fail(path, 'schema_version must be 1');
  for (const key of ['skill_hash', 'rubric_hash']) if (!HEX64.test(str(o, key, path))) fail(path, `${key} must be sha256 hex`);
  const scoresRaw = o['scores'];
  if (scoresRaw === null || typeof scoresRaw !== 'object') fail(path, 'scores must be an object');
  const scores = {} as Scores;
  for (const dimension of DIMENSIONS) {
    const score = (scoresRaw as Record<string, unknown>)[dimension];
    if (!Number.isInteger(score) || (score as number) < 1 || (score as number) > 5) fail(path, `scores.${dimension} must be an integer 1-5`);
    scores[dimension] = score as number;
  }
  const rationaleRaw = (o['rationale'] ?? {}) as Record<string, unknown>;
  const rationale = {} as Record<Dimension, string>;
  for (const dimension of DIMENSIONS) rationale[dimension] = typeof rationaleRaw[dimension] === 'string' ? (rationaleRaw[dimension] as string) : '';
  const gates = o['hard_gates'];
  if (gates === null || typeof gates !== 'object') fail(path, 'hard_gates must be an object');
  const g = gates as Record<string, unknown>;
  for (const key of ['schema_valid', 'contract_complete', 'forbidden_absent']) if (typeof g[key] !== 'boolean') fail(path, `hard_gates.${key} must be boolean`);
  return {
    schema_version: 1,
    role: str(o, 'role', path),
    scenario: str(o, 'scenario', path),
    skill_hash: str(o, 'skill_hash', path),
    rubric_hash: str(o, 'rubric_hash', path),
    executor_model: str(o, 'executor_model', path),
    judge_model: str(o, 'judge_model', path),
    recorded_at: str(o, 'recorded_at', path),
    output_text: str(o, 'output_text', path),
    output_envelope: o['output_envelope'],
    scores,
    rationale,
    hard_gates: { schema_valid: g['schema_valid'] as boolean, contract_complete: g['contract_complete'] as boolean, forbidden_absent: g['forbidden_absent'] as boolean },
  };
}

export const recordingPath = (role: string, name: string): string => join(recordingsDir, role, `${name}.json`);

export function readRecording(role: string, name: string): Recording | undefined {
  const path = recordingPath(role, name);
  if (!existsSync(path)) return undefined;
  return parseRecording(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
}

export function writeRecording(recording: Recording): void {
  const path = recordingPath(recording.role, recording.scenario);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`);
}

export function listRecordings(role: string): Map<string, Recording> {
  const dir = join(recordingsDir, role);
  const out = new Map<string, Recording>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const name = file.replace(/\.json$/, '');
    out.set(name, parseRecording(JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown, join(dir, file)));
  }
  return out;
}
