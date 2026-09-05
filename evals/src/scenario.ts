import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { scenariosDir } from './paths.js';

export type Scenario = Readonly<{
  role: string;
  name: string;
  title: string;
  inputEnvelope: unknown;
  expectedTopics: string[];
  mustNotClaim: string[];
  body: string;
  path: string;
}>;

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

const stringList = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`scenario field ${field} must be a non-empty string list`);
  }
  return value as string[];
};

export function parseScenario(role: string, name: string, markdown: string, path = `${role}/${name}.md`): Scenario {
  const match = FRONTMATTER.exec(markdown);
  if (!match) throw new Error(`${path}: missing frontmatter`);
  const front = parse(match[1] ?? '') as Record<string, unknown> | null;
  if (front === null || typeof front !== 'object') throw new Error(`${path}: invalid frontmatter`);
  if (front['role'] !== role) throw new Error(`${path}: role mismatch (${String(front['role'])} vs ${role})`);
  if (typeof front['title'] !== 'string' || !front['title'].trim()) throw new Error(`${path}: title is required`);
  if (front['input_envelope'] === undefined || front['input_envelope'] === null || typeof front['input_envelope'] !== 'object') {
    throw new Error(`${path}: input_envelope is required`);
  }
  const body = (match[2] ?? '').trim();
  if (!body) throw new Error(`${path}: body is required`);
  return Object.freeze({
    role,
    name,
    title: front['title'],
    inputEnvelope: front['input_envelope'],
    expectedTopics: stringList(front['expected_topics'], 'expected_topics'),
    mustNotClaim: stringList(front['must_not_claim'], 'must_not_claim'),
    body,
    path,
  });
}

export function listScenarios(role: string): Scenario[] {
  const dir = join(scenariosDir, role);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.md')).sort()
    .map((file) => parseScenario(role, file.replace(/\.md$/, ''), readFileSync(join(dir, file), 'utf8'), join(dir, file)));
}
