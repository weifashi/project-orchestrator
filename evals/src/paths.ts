import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// 编译后位于 evals/dist/paths.js，源码位于 evals/src/paths.ts；两者到仓库根都是两级。
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const skillsDir = join(repoRoot, 'skills');
export const evalsDir = join(repoRoot, 'evals');
export const scenariosDir = join(evalsDir, 'scenarios');
export const recordingsDir = join(evalsDir, 'recordings');
export const rubricPath = join(evalsDir, 'rubric.md');
export const baselinePath = join(evalsDir, 'baseline.json');
