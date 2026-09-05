import { ContractValidator } from '@project-orchestrator/contracts';
import type { RoleFiles } from './roles.js';
import type { Scenario } from './scenario.js';
import { DIMENSIONS, type Recording, type Scores } from './recording.js';
import { roleMeans } from './baseline.js';

export const MIN_AVERAGE = 3.5;
export const REGRESSION_FLOOR = 0.9;
export const MIN_SCENARIOS = 2;

export type HardGates = { schema_valid: boolean; contract_complete: boolean; forbidden_absent: boolean; failures: string[] };

const validator = new ContractValidator();

// 完成契约以「- `field` is present …」列出交付物；取反引号里的标识符。
export function contractFields(completionContract: string): string[] {
  return [...completionContract.matchAll(/^- `([a-z0-9_]+)`/gm)].map((match) => match[1]!);
}

export function checkHardGates(role: RoleFiles, scenario: Scenario, outputEnvelope: unknown, outputText: string): HardGates {
  const failures: string[] = [];
  let schemaValid = true;
  try {
    validator.checkJsonSchema(role.outputSchema, outputEnvelope);
  } catch (error) {
    schemaValid = false;
    failures.push(`schema_valid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const deliverables = ((outputEnvelope as { data?: { deliverables?: unknown } } | null)?.data?.deliverables ?? {}) as Record<string, unknown>;
  const missing = contractFields(role.completionContract)
    .filter((field) => typeof deliverables[field] !== 'string' || (deliverables[field] as string).trim() === '');
  const contractComplete = missing.length === 0;
  if (!contractComplete) failures.push(`contract_complete: missing or empty deliverables ${missing.join(', ')}`);

  const haystack = outputText.toLowerCase();
  const found = scenario.mustNotClaim.filter((claim) => haystack.includes(claim.toLowerCase()));
  const forbiddenAbsent = found.length === 0;
  if (!forbiddenAbsent) failures.push(`forbidden_absent: output contains ${found.map((claim) => JSON.stringify(claim)).join(', ')}`);

  return { schema_valid: schemaValid, contract_complete: contractComplete, forbidden_absent: forbiddenAbsent, failures };
}

export type RoleGateInput = {
  role: string;
  scenarios: Scenario[];
  recordings: Map<string, Recording>;
  currentSkillHash: string;
  currentRubricHash: string;
  baseline: Scores | undefined;
};

export function checkRoleGate(input: RoleGateInput): { ok: boolean; failures: string[]; means?: Scores } {
  const failures: string[] = [];
  const { role } = input;
  if (input.scenarios.length < MIN_SCENARIOS) failures.push(`${role}: needs at least ${MIN_SCENARIOS} scenarios, has ${input.scenarios.length}`);

  const present: Recording[] = [];
  for (const scenario of input.scenarios) {
    const recording = input.recordings.get(scenario.name);
    if (!recording) { failures.push(`${role}: missing recording for scenario ${scenario.name}`); continue; }
    if (recording.skill_hash !== input.currentSkillHash) {
      failures.push(`${role}/${scenario.name}: skill files changed since recording — run \`pnpm evals:record --role ${role}\` and commit the result`);
    }
    if (recording.rubric_hash !== input.currentRubricHash) {
      failures.push(`${role}/${scenario.name}: rubric changed since recording — run \`pnpm evals:record\` and commit the result`);
    }
    for (const gate of ['schema_valid', 'contract_complete', 'forbidden_absent'] as const) {
      if (!recording.hard_gates[gate]) failures.push(`${role}/${scenario.name}: hard gate ${gate} failed`);
    }
    present.push(recording);
  }
  if (present.length === 0) return { ok: false, failures };

  const means = roleMeans(present);
  const average = DIMENSIONS.reduce((sum, dimension) => sum + means[dimension], 0) / DIMENSIONS.length;
  if (average < MIN_AVERAGE) failures.push(`${role}: average ${average.toFixed(2)} is below ${MIN_AVERAGE}`);
  if (input.baseline) {
    for (const dimension of DIMENSIONS) {
      const floor = input.baseline[dimension] * REGRESSION_FLOOR;
      if (means[dimension] < floor) failures.push(`${role}: ${dimension} ${means[dimension]} fell below 90% of baseline ${input.baseline[dimension]}`);
    }
  }
  return { ok: failures.length === 0, failures, means };
}
