import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rubricPath } from './paths.js';
import { readRole, type RoleFiles } from './roles.js';

// 顺序固定：SKILL.md 在前，references 按文件名升序。每段前缀文件名，避免两个文件内容对调却哈希不变。
export function hashRoleFiles(files: RoleFiles): string {
  const hash = createHash('sha256');
  hash.update(`SKILL.md\n${files.skill}\n`);
  for (const name of Object.keys(files.references).sort()) hash.update(`${name}\n${files.references[name]}\n`);
  return hash.digest('hex');
}

export function skillHash(role: string): string {
  return hashRoleFiles(readRole(role));
}

export function rubricHash(): string {
  return createHash('sha256').update(readFileSync(rubricPath, 'utf8')).digest('hex');
}
