import { readFileSync } from 'node:fs';
import process from 'node:process';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { hashRoleFiles, rubricHash } from './hash.js';
import { listRoles, readRole } from './roles.js';
import { listScenarios, type Scenario } from './scenario.js';
import { writeRecording, listRecordings, type Recording } from './recording.js';
import { readBaseline, roleMeans, writeBaseline } from './baseline.js';
import { checkHardGates } from './gate.js';
import { executorPrompt, extractJsonObject, judgePrompt } from './prompts.js';
import { JudgeOutput } from './judge-schema.js';
import { rubricPath } from './paths.js';

const EXECUTOR_MODEL = process.env['PO_EVAL_EXECUTOR_MODEL'] ?? 'claude-opus-5';
const JUDGE_MODEL = process.env['PO_EVAL_JUDGE_MODEL'] ?? 'claude-opus-5';

// argv[++index] 是 string | undefined；exactOptionalPropertyTypes 下可选属性必须显式允许 undefined。
type Args = { role?: string | undefined; scenario?: string | undefined; accept: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { accept: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--accept') args.accept = true;
    else if (flag === '--role') args.role = argv[++index];
    else if (flag === '--scenario') args.scenario = argv[++index];
    else throw new Error(`unknown flag: ${flag}`);
  }
  return args;
}

const log = (message: string): void => { process.stdout.write(`${message}\n`); };

async function runExecutor(client: Anthropic, system: string, user: string): Promise<string> {
  const stream = client.messages.stream({
    model: EXECUTOR_MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system,
    messages: [{ role: 'user', content: user }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error(`executor refused: ${message.stop_details?.explanation ?? 'no explanation'}`);
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

async function runJudge(client: Anthropic, system: string, user: string): Promise<JudgeOutput> {
  const response = await client.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: zodOutputFormat(JudgeOutput) },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (!response.parsed_output) throw new Error('judge returned no parseable output');
  return response.parsed_output;
}

async function recordScenario(client: Anthropic, rubric: string, currentRubricHash: string, scenario: Scenario): Promise<Recording> {
  const role = readRole(scenario.role);
  const executor = executorPrompt(role, scenario);
  const outputText = await runExecutor(client, executor.system, executor.user);
  // 解析失败也要落盘：schema 硬门会把它记为失败，而不是让录制缺席。
  const outputEnvelope = extractJsonObject(outputText) ?? { schema_id: 'invalid', schema_version: 1, data: { raw: outputText } };
  const gates = checkHardGates(role, scenario, outputEnvelope, outputText);
  const judge = judgePrompt(rubric, role, scenario, outputText);
  const verdict = await runJudge(client, judge.system, judge.user);
  const recording: Recording = {
    schema_version: 1,
    role: scenario.role,
    scenario: scenario.name,
    skill_hash: hashRoleFiles(role),
    rubric_hash: currentRubricHash,
    executor_model: EXECUTOR_MODEL,
    judge_model: JUDGE_MODEL,
    recorded_at: new Date().toISOString(),
    output_text: outputText,
    output_envelope: outputEnvelope,
    scores: verdict.scores,
    rationale: verdict.rationale,
    hard_gates: { schema_valid: gates.schema_valid, contract_complete: gates.contract_complete, forbidden_absent: gates.forbidden_absent },
  };
  writeRecording(recording);
  const summary = Object.entries(verdict.scores).map(([dimension, score]) => `${dimension}=${score}`).join(' ');
  log(`${scenario.role}/${scenario.name}: ${summary}${gates.failures.length ? `  !! ${gates.failures.join(' | ')}` : ''}`);
  return recording;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = new Anthropic();
  // 凭据由 SDK 解析（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` 配置）。
  // 先做一次最便宜的调用把鉴权失败暴露在最前面，而不是等到第一条场景跑到一半。
  try {
    await client.models.retrieve(EXECUTOR_MODEL);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new Error('no usable Anthropic credentials: set ANTHROPIC_API_KEY or run `ant auth login`');
    }
    throw error;
  }

  const rubric = readFileSync(rubricPath, 'utf8');
  const currentRubricHash = rubricHash();
  const roles = args.role ? [args.role] : listRoles();
  const selected: Scenario[] = [];
  for (const role of roles) {
    for (const scenario of listScenarios(role)) {
      if (args.scenario && args.scenario !== `${role}/${scenario.name}`) continue;
      selected.push(scenario);
    }
  }
  if (selected.length === 0) throw new Error('no scenarios matched');
  log(`recording ${selected.length} scenario(s) with executor=${EXECUTOR_MODEL} judge=${JUDGE_MODEL}`);

  for (const scenario of selected) await recordScenario(client, rubric, currentRubricHash, scenario);

  if (args.accept) {
    const baseline = readBaseline();
    for (const role of roles) {
      const recordings = [...listRecordings(role).values()];
      if (recordings.length) baseline.roles[role] = roleMeans(recordings);
    }
    baseline.updated_at = new Date().toISOString();
    writeBaseline(baseline);
    log(`baseline updated for ${roles.join(', ')}`);
  } else {
    log('recordings written; baseline unchanged (pass --accept to update it)');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
