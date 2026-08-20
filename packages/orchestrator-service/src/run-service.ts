import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { canonicalJson, type ContentStore } from '@project-orchestrator/content-store';
import {
  ContractValidator,
  RoleVersionEnvelopeSchema,
  type MemoryRetentionPolicy,
  type MemoryScope,
  type MemoryType,
  SucceededStageOutputEnvelopeSchema,
  type StageOutputEnvelope,
  type RoleVersionEnvelope,
  type WorkflowStage,
  type WorkflowVersionEnvelope,
} from '@project-orchestrator/contracts';
import {
  assertAttemptTransition,
  assertRunTransition,
  assertStageTransition,
  deriveFrontier,
  reduceIteration,
  validateWorkflowGraph,
  type RunStatus,
  type StageStatus,
} from '@project-orchestrator/workflow-engine';
import { EventRepository, IdempotencyRepository, RunRepository, type RunRow, type StageRunRow } from '@project-orchestrator/sqlite-store';
import { LeaseService, type ClaimedLease } from './lease-service.js';
import type { AdapterPrincipal, LeaseProof, WorkspaceState } from './runtime-types.js';
import { EvidenceService, workspaceFingerprint } from './evidence-service.js';
import { ConfirmationService } from './confirmation-service.js';
import { RecoveryService } from './recovery-service.js';
import { MemoryService } from './memory-service.js';

const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
type RunRecord = RunRow;
type AttemptRow = { id: string; stage_run_id: string; attempt_number: number; status: string };
type PublishedWorkflowRow = { id: string; content_object_id: string; safety_baseline_version: number };
type InstallationRow = { status: string; capability_object_id: string; client_type: string };
type FrozenRoleBundle = { roles: Array<{ roleVersionId: string; envelope: RoleVersionEnvelope }> };
type ArtifactRow = { id: string; content_object_id: string; artifact_type: string };
type CompletionRequirement = { artifact_type: string; min_count: number };

export type RunServiceOptions = Readonly<{ ruleBundle?: unknown; safetyBaseline?: unknown }>;

export class RunService {
  readonly runs: RunRepository;
  readonly events: EventRepository;
  readonly idem: IdempotencyRepository;
  readonly #validator = new ContractValidator();
  readonly #ruleBundle: unknown;
  readonly #safetyBaseline: unknown;

  constructor(
    readonly db: Database.Database,
    readonly content: ContentStore,
    readonly leases: LeaseService,
    options: RunServiceOptions = {},
  ) {
    this.runs = new RunRepository(db);
    this.events = new EventRepository(db);
    this.idem = new IdempotencyRepository(db);
    this.#ruleBundle = options.ruleBundle ?? { schema_id: 'project-orchestrator/rule-bundle', schema_version: 1, data: {} };
    this.#safetyBaseline = options.safetyBaseline ?? { schema_id: 'project-orchestrator/safety-baseline', schema_version: 1, data: { version: 1 } };
  }

  createRun(input: {
    requestId: string; projectId: string; workflowVersionId: string; objective: string; runInput: unknown;
    principal: AdapterPrincipal; workspace: WorkspaceState;
  }): { runId: string } {
    return this.command(input.principal.installationId, 'create_run', input.requestId, input, () => {
      if (input.principal.sessionId !== input.principal.rootSessionId) throw new Error('POLICY_VIOLATION: subagent write rejected');
      const version = this.db.prepare(`SELECT id,content_object_id,safety_baseline_version FROM workflow_versions WHERE id=?`)
        .get(input.workflowVersionId) as PublishedWorkflowRow | undefined;
      if (!version) throw new Error('NOT_FOUND: workflow version');
      const installation = this.db.prepare('SELECT status,capability_object_id,client_type FROM client_installations WHERE id=?')
        .get(input.principal.installationId) as InstallationRow | undefined;
      if (installation?.status !== 'active' || installation.client_type !== input.principal.clientType) {
        throw new Error('POLICY_VIOLATION: inactive or mismatched installation');
      }
      const project = this.db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(input.projectId) as
        { canonical_path: string } | undefined;
      if (!project) throw new Error('NOT_FOUND: project');
      if (!this.sameCanonicalProject(project.canonical_path, input.principal.canonicalProjectPath)) {
        throw new Error('PROJECT_PATH_CHANGED: authenticated adapter project does not match selected project');
      }
      const workflow = this.readJson<WorkflowVersionEnvelope>(version.content_object_id);
      validateWorkflowGraph(workflow.data);
      const roleBundle = workflow.data.stages.map((stage) => {
        const row = this.db.prepare(`SELECT content_object_id,status FROM role_versions WHERE id=?`)
          .get(stage.role_version_id) as { content_object_id: string; status: string } | undefined;
        if (!row || row.status !== 'published') throw new Error(`POLICY_VIOLATION: unavailable role ${stage.role_version_id}`);
        this.content.verify(row.content_object_id);
        return {
          roleVersionId: stage.role_version_id,
          envelope: this.#validator.check(RoleVersionEnvelopeSchema, this.readJson<unknown>(row.content_object_id)),
        };
      });
      const roleObject = this.content.putCanonicalJson({ roles: roleBundle });
      const ruleObject = this.content.putCanonicalJson(this.#ruleBundle);
      const safetyObject = this.content.putCanonicalJson(this.#safetyBaseline);
      if (version.safety_baseline_version !== 1) throw new Error('SAFETY_BASELINE_INCOMPATIBLE');
      this.content.verify(version.content_object_id);
      this.content.verify(installation.capability_object_id);
      const staged = this.content.putUtf8(input.workspace.stagedPatch);
      const unstaged = this.content.putUtf8(input.workspace.unstagedPatch);
      const untracked = this.content.putCanonicalJson(input.workspace.untrackedManifest);
      const submodules = this.content.putCanonicalJson(input.workspace.submoduleManifest);
      const fingerprint = workspaceFingerprint(input.workspace);
      const runId = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO runs
        (id,project_id,workflow_version_id,objective,input_envelope,origin_client_type,client_installation_id,origin_session_id,status,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(runId, input.projectId, input.workflowVersionId, input.objective, canonicalJson(input.runInput),
          input.principal.clientType, input.principal.installationId, input.principal.rootSessionId, 'created', now);
      this.db.prepare(`INSERT INTO run_snapshots
        (run_id,workflow_object_id,role_bundle_object_id,rule_bundle_object_id,safety_baseline_object_id,
         adapter_capability_object_id,repository_head,staged_patch_object_id,unstaged_patch_object_id,
         untracked_manifest_object_id,submodule_manifest_object_id,working_tree_fingerprint,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(runId, version.content_object_id, roleObject.id, ruleObject.id, safetyObject.id, installation.capability_object_id,
          input.workspace.repositoryHead, staged.id, unstaged.id, untracked.id, submodules.id, fingerprint, now);
      for (const stage of workflow.data.stages) {
        this.insertStageRun(runId, stage, stage.iteration_group_key ? 1 : 0, 'queued', now);
      }
      new EvidenceService(this.db, this.content).recordCheckpoint({
        runId, kind: 'run_start', baselineFingerprint: fingerprint, state: input.workspace,
      });
      this.events.append(runId, 'run_created', 'server', { workflowVersionId: input.workflowVersionId });
      this.refreshFrontier(runId);
      this.failRunIfExhausted(runId, 'REQUIREMENTS_NOT_MET', 'A required stage is unreachable');
      return { runId };
    });
  }

  claimRun(input: {
    requestId: string; runId: string; mode: 'start' | 'resume' | 'recover' | 'retry';
    expectedStatus: 'created' | 'paused' | 'interrupted' | 'failed'; expectedLeaseEpoch: number;
    stageRunId?: string; recoveryCredential?: string; currentWorkspace?: WorkspaceState; principal: AdapterPrincipal;
  }): ClaimedLease {
    const requestForHash = {
      requestId: input.requestId, runId: input.runId, mode: input.mode, expectedStatus: input.expectedStatus,
      expectedLeaseEpoch: input.expectedLeaseEpoch, stageRunId: input.stageRunId ?? null,
      recoveryCredentialHash: input.recoveryCredential === undefined ? null : digest(input.recoveryCredential),
      currentWorkspace: input.currentWorkspace ?? null, principal: input.principal,
    };
    const outcome = this.db.transaction(() => {
      const begun = this.idem.begin(input.principal.installationId, 'claim_run', input.requestId, digest(requestForHash));
      if (begun.kind === 'replay') throw new Error('ALREADY_CLAIMED');
      if (input.mode !== 'start') {
        if (!input.currentWorkspace) throw new Error('WORKTREE_CHANGED: recovery workspace required');
        const recovery = new RecoveryService(this.db, this.content).check(
          input.runId, input.currentWorkspace, this.recoveryContext(input.runId, input.principal),
        );
        if (!recovery.ok) throw new Error(`${recovery.code}: ${recovery.diffObjectId}`);
        this.assertSnapshotCompatible(input.runId, input.principal.installationId);
      }
      const lease = this.leases.claim({
        runId: input.runId, principal: input.principal, mode: input.mode, expectedStatus: input.expectedStatus,
        expectedLeaseEpoch: input.expectedLeaseEpoch,
        ...(input.recoveryCredential === undefined ? {} : { recoveryCredential: input.recoveryCredential }),
      });
      if (input.mode === 'retry') {
        if (!input.stageRunId) throw new Error('INVALID_TRANSITION: retry requires stage');
        const stage = this.requireStageForRun(input.stageRunId, input.runId);
        if (!['failed', 'interrupted'].includes(stage.status)) throw new Error('INVALID_TRANSITION: retry stage');
        if (stage.status === 'failed' && this.definition(input.runId, stage.stage_key).failure_policy !== 'retry_then_fail') {
          throw new Error('POLICY_VIOLATION: failure policy forbids failed-run retry');
        }
        this.createAttempt(stage, stage.status as 'failed' | 'interrupted', {});
      }
      this.events.append(input.runId, 'run_claimed', 'server', { mode: input.mode, leaseEpoch: lease.leaseEpoch });
      this.refreshFrontier(input.runId);
      this.failRunIfExhausted(input.runId, 'REQUIREMENTS_NOT_MET', 'A required stage is unreachable');
      const afterRefresh = this.requireRun(input.runId);
      if (afterRefresh.status === 'failed') {
        this.idem.complete(begun.id, { claimed: false, failureCode: afterRefresh.failure_code });
        return { kind: 'failed' as const, failureCode: afterRefresh.failure_code ?? 'CONDITION_EVALUATION_FAILED' };
      }
      this.idem.complete(begun.id, { claimed: true, leaseEpoch: lease.leaseEpoch });
      return { kind: 'claimed' as const, lease };
    }).immediate();
    if (outcome.kind === 'failed') throw new Error(`${outcome.failureCode}: run failed while evaluating frontier`);
    return outcome.lease;
  }

  heartbeat(input: { requestId: string; proof: LeaseProof; principal: AdapterPrincipal }): { expiresAt: string } {
    return this.leased(input, 'heartbeat_run', () => {
      const expiresAt = this.leases.heartbeat(input.proof, input.principal);
      this.events.append(input.proof.runId, 'run_heartbeat', 'server', { expiresAt });
      return { expiresAt };
    });
  }

  beginStage(input: { requestId: string; proof: LeaseProof; stageRunId: string; principal: AdapterPrincipal; stageInput?: unknown }): { attemptId: string } {
    return this.leased(input, 'begin_stage', () => {
      const stage = this.requireStageForRun(input.stageRunId, input.proof.runId, 'ready');
      return this.createAttempt(stage, 'ready', input.stageInput ?? {});
    });
  }

  retryStage(input: { requestId: string; proof: LeaseProof; stageRunId: string; principal: AdapterPrincipal; stageInput?: unknown }): { attemptId: string } {
    return this.leased(input, 'retry_stage', () => {
      const stage = this.requireStageForRun(input.stageRunId, input.proof.runId);
      if (!['failed', 'interrupted'].includes(stage.status)) throw new Error('INVALID_TRANSITION: stage retry');
      const policy = this.definition(input.proof.runId, stage.stage_key).failure_policy;
      if (stage.status === 'failed' && policy !== 'retry_then_fail' && policy !== 'pause') {
        throw new Error('POLICY_VIOLATION: failure policy forbids retry');
      }
      return this.createAttempt(stage, stage.status as 'failed' | 'interrupted', input.stageInput ?? {});
    });
  }

  completeStage(input: {
    requestId: string; proof: LeaseProof; stageRunId: string; principal: AdapterPrincipal;
    output: unknown; changedFiles?: unknown; workspace: WorkspaceState;
  }): { stageRunId: string } {
    return this.leased(input, 'complete_stage', () => {
      const stage = this.requireStageForRun(input.stageRunId, input.proof.runId, 'running');
      const attempt = this.requireRunningAttempt(stage.latest_attempt_id, stage.id);
      const definition = this.definition(input.proof.runId, stage.stage_key);
      if (definition.requires_confirmation && !this.hasConsumedConfirmation(input.proof.runId, stage.id, attempt.id)) {
        throw new Error('POLICY_VIOLATION: consumed confirmation required for current attempt');
      }
      const output = this.#validator.check(SucceededStageOutputEnvelopeSchema, input.output) as StageOutputEnvelope;
      const referencedIds = [...output.data.artifact_object_ids, ...output.data.evidence_object_ids,
        ...(output.data.changed_file_manifest_object_id === undefined ? [] : [output.data.changed_file_manifest_object_id])];
      this.validateReferencedContent(referencedIds);
      const ownedArtifacts = this.db.prepare(`SELECT id,content_object_id,artifact_type FROM artifacts
        WHERE run_id=? AND stage_attempt_id=? ORDER BY id`).all(input.proof.runId, attempt.id) as ArtifactRow[];
      const ownedContent = new Set(ownedArtifacts.map((artifact) => artifact.content_object_id));
      for (const id of referencedIds) {
        if (!ownedContent.has(id)) throw new Error('POLICY_VIOLATION: output references artifact not owned by attempt');
      }
      this.validateFrozenRoleContract(input.proof.runId, stage.role_version_id, output, ownedArtifacts);
      const artifactIds = new Set(output.data.artifact_object_ids);
      const evidenceIds = new Set(output.data.evidence_object_ids);
      const artifactManifest = this.content.putCanonicalJson(ownedArtifacts.filter((artifact) => artifactIds.has(artifact.content_object_id)));
      const evidenceManifest = this.content.putCanonicalJson(ownedArtifacts.filter((artifact) => evidenceIds.has(artifact.content_object_id)));
      const changed = output.data.changed_file_manifest_object_id === undefined
        ? this.content.putCanonicalJson(input.changedFiles ?? [])
        : { id: output.data.changed_file_manifest_object_id };
      const now = new Date().toISOString();
      assertStageTransition('running', 'succeeded');
      assertAttemptTransition('running', 'succeeded');
      this.db.prepare(`UPDATE stage_attempts SET status='succeeded',output_envelope=?,artifact_manifest_object_id=?,
        evidence_manifest_object_id=?,changed_files_object_id=?,completed_at=? WHERE id=? AND status='running'`)
        .run(canonicalJson(output), artifactManifest.id, evidenceManifest.id, changed.id, now, attempt.id);
      this.db.prepare(`UPDATE stage_runs SET status='succeeded',updated_at=?,completed_at=? WHERE id=? AND status='running'`)
        .run(now, now, stage.id);
      const lastCheckpoint = this.db.prepare(`SELECT resulting_fingerprint FROM workspace_checkpoints
        WHERE run_id=? ORDER BY sequence_number DESC LIMIT 1`).get(input.proof.runId) as { resulting_fingerprint: string } | undefined;
      const checkpoint = new EvidenceService(this.db, this.content).recordCheckpoint({
        runId: input.proof.runId, stageAttemptId: attempt.id, kind: 'after_attempt',
        baselineFingerprint: lastCheckpoint?.resulting_fingerprint ?? workspaceFingerprint(input.workspace), state: input.workspace,
      });
      this.events.append(input.proof.runId, 'checkpoint_recorded', 'server', { checkpointId: checkpoint.id }, stage.id);
      this.events.append(input.proof.runId, 'stage_succeeded', 'server', { attemptId: attempt.id }, stage.id);
      this.advanceIterations(input.proof.runId, stage);
      this.refreshFrontier(input.proof.runId);
      this.failRunIfExhausted(input.proof.runId, 'STAGE_FAILED', 'A required stage failed');
      return { stageRunId: stage.id };
    });
  }

  failStage(input: {
    requestId: string; proof: LeaseProof; stageRunId: string; principal: AdapterPrincipal;
    errorCode: string; summary: string;
  }): { stageRunId: string } {
    return this.leased(input, 'fail_stage', () => {
      const stage = this.requireStageForRun(input.stageRunId, input.proof.runId, 'running');
      const attempt = this.requireRunningAttempt(stage.latest_attempt_id, stage.id);
      const definition = this.definition(input.proof.runId, stage.stage_key);
      const evidenceRows = this.db.prepare(`SELECT id,content_object_id FROM artifacts
        WHERE run_id=? AND stage_attempt_id=? AND artifact_type='test_evidence' ORDER BY id`)
        .all(input.proof.runId, attempt.id);
      const evidence = this.content.putCanonicalJson(evidenceRows);
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE stage_attempts SET status='failed',failure_code=?,failure_summary=?,
        evidence_manifest_object_id=?,completed_at=? WHERE id=? AND status='running'`)
        .run(input.errorCode, input.summary, evidence.id, now, attempt.id);
      this.db.prepare(`UPDATE stage_runs SET status='failed',updated_at=?,completed_at=? WHERE id=? AND status='running'`)
        .run(now, now, stage.id);
      this.events.append(input.proof.runId, 'stage_failed', 'server', { errorCode: input.errorCode }, stage.id);
      this.applyFailurePolicy(input.proof.runId, stage, definition, input.errorCode, input.summary);
      return { stageRunId: stage.id };
    });
  }

  skipStage(input: { requestId: string; proof: LeaseProof; stageRunId: string; principal: AdapterPrincipal }): { stageRunId: string } {
    return this.leased(input, 'skip_stage', () => {
      const stage = this.requireStageForRun(input.stageRunId, input.proof.runId);
      if (!['queued', 'ready'].includes(stage.status)) throw new Error('INVALID_TRANSITION: skip');
      const definition = this.definition(input.proof.runId, stage.stage_key);
      if (!definition.optional || definition.mandatory_gate) throw new Error('POLICY_VIOLATION: required stage');
      this.finishStage(stage.id, stage.status, 'skipped');
      this.events.append(input.proof.runId, 'stage_skipped', 'server', {}, stage.id);
      this.refreshFrontier(input.proof.runId);
      return { stageRunId: stage.id };
    });
  }

  pauseRun(input: { requestId: string; proof: LeaseProof; principal: AdapterPrincipal }): void {
    return this.leased(input, 'pause_run', () => this.pause(input.proof.runId));
  }

  cancelRun(input: { requestId: string; proof: LeaseProof; principal: AdapterPrincipal }): void {
    return this.leased(input, 'cancel_run', () => {
      const run = this.requireRun(input.proof.runId);
      assertRunTransition(run.status as RunStatus, 'cancelled');
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE runs SET status='cancelled',completed_at=?,updated_at=? WHERE id=? AND status=?`)
        .run(now, now, run.id, run.status);
      this.db.prepare(`UPDATE stage_runs SET status='cancelled',updated_at=?,completed_at=?
        WHERE run_id=? AND status IN ('queued','ready','running','waiting_for_user')`).run(now, now, run.id);
      this.db.prepare(`UPDATE stage_attempts SET status='interrupted',completed_at=? WHERE status='running'
        AND stage_run_id IN (SELECT id FROM stage_runs WHERE run_id=?)`).run(now, run.id);
      this.leases.release(run.id);
      this.events.append(run.id, 'run_cancelled', 'server', {});
    });
  }

  finalizeRun(input: { requestId: string; proof: LeaseProof; principal: AdapterPrincipal }): void {
    return this.leased(input, 'finalize_run', () => {
      const run = this.requireRun(input.proof.runId);
      const workflow = this.workflow(run.id);
      const stages = this.runs.listStageRuns(run.id);
      for (const group of workflow.data.iteration_groups) {
        const latest = this.db.prepare(`SELECT status,iteration_number FROM run_iterations
          WHERE run_id=? AND group_key=? ORDER BY iteration_number DESC LIMIT 1`).get(run.id, group.key) as { status: string; iteration_number: number } | undefined;
        if (latest?.status !== 'succeeded') throw new Error(`POLICY_VIOLATION: latest iteration ${group.key} incomplete`);
        for (const key of [group.entry_stage_key, ...group.gate_stage_keys]) {
          const stage = stages.find((candidate) => candidate.stage_key === key && candidate.iteration_number === latest.iteration_number);
          if (stage?.status !== 'succeeded') throw new Error(`POLICY_VIOLATION: latest iteration stage ${key} incomplete`);
        }
      }
      for (const definition of workflow.data.stages.filter((stage) => (!stage.optional || stage.mandatory_gate)
        && stage.iteration_group_key === undefined)) {
        const stage = stages.find((candidate) => candidate.stage_key === definition.key && candidate.iteration_number === 0);
        if (stage?.status !== 'succeeded') throw new Error(`POLICY_VIOLATION: required stage ${definition.key} incomplete`);
      }
      const latestByKey = new Map<string, StageRunRow>();
      for (const stage of stages) {
        const current = latestByKey.get(stage.stage_key);
        if (!current || stage.iteration_number > current.iteration_number) latestByKey.set(stage.stage_key, stage);
      }
      for (const [key, stage] of latestByKey) {
        if (stage.status !== 'succeeded' || !stage.latest_attempt_id) continue;
        const attempt = this.db.prepare(`SELECT status,output_envelope,artifact_manifest_object_id,
          evidence_manifest_object_id,changed_files_object_id FROM stage_attempts WHERE id=? AND stage_run_id=?`)
          .get(stage.latest_attempt_id, stage.id) as { status: string; output_envelope: string | null;
            artifact_manifest_object_id: string | null; evidence_manifest_object_id: string | null; changed_files_object_id: string | null } | undefined;
        if (!attempt || attempt.status !== 'succeeded' || !attempt.output_envelope || !attempt.artifact_manifest_object_id
          || !attempt.evidence_manifest_object_id || !attempt.changed_files_object_id) {
          throw new Error(`POLICY_VIOLATION: latest attempt ${key} lacks frozen completion evidence`);
        }
        for (const objectId of [attempt.artifact_manifest_object_id, attempt.evidence_manifest_object_id, attempt.changed_files_object_id]) {
          this.content.verify(objectId);
        }
        const validatedOutput = this.#validator.check(SucceededStageOutputEnvelopeSchema, JSON.parse(attempt.output_envelope)) as StageOutputEnvelope;
        const artifacts = this.db.prepare(`SELECT id,content_object_id,artifact_type FROM artifacts
          WHERE run_id=? AND stage_attempt_id=? ORDER BY id`).all(run.id, stage.latest_attempt_id) as ArtifactRow[];
        this.validateFrozenRoleContract(run.id, stage.role_version_id, validatedOutput, artifacts);
        const definition = workflow.data.stages.find((candidate) => candidate.key === key);
        if (definition?.requires_confirmation && !this.hasConsumedConfirmation(run.id, stage.id, stage.latest_attempt_id)) {
          throw new Error(`POLICY_VIOLATION: required confirmation missing for ${key}`);
        }
      }
      const succeededWithoutManifest = this.db.prepare(`SELECT 1 FROM stage_attempts a JOIN stage_runs s ON s.id=a.stage_run_id
        WHERE s.run_id=? AND a.status='succeeded' AND (a.artifact_manifest_object_id IS NULL OR a.evidence_manifest_object_id IS NULL OR a.changed_files_object_id IS NULL) LIMIT 1`).get(run.id);
      if (succeededWithoutManifest) throw new Error('POLICY_VIOLATION: succeeded attempt lacks frozen manifests');
      if (this.db.prepare(`SELECT 1 FROM confirmation_requests WHERE run_id=? AND status IN ('pending','approved') LIMIT 1`).get(run.id)) {
        throw new Error('POLICY_VIOLATION: outstanding confirmation');
      }
      if (this.db.prepare(`SELECT 1 FROM side_effect_operations WHERE run_id=? AND status IN ('intent_recorded','executing','unknown') LIMIT 1`).get(run.id)) {
        throw new Error('POLICY_VIOLATION: unresolved side effect');
      }
      assertRunTransition(run.status as RunStatus, 'completed');
      if (run.status !== 'running') throw new Error('INVALID_TRANSITION: finalize requires running run');
      const now = new Date().toISOString();
      const completed = this.db.prepare(`UPDATE runs SET status='completed',completed_at=?,updated_at=? WHERE id=? AND status='running'`)
        .run(now, now, run.id);
      if (completed.changes !== 1) throw new Error('INVALID_TRANSITION: finalize race');
      this.leases.release(run.id);
      this.events.append(run.id, 'run_completed', 'server', {});
    });
  }

  appendAgentNote(input: { requestId: string; proof: LeaseProof; principal: AdapterPrincipal; note: string }): void {
    return this.leased(input, 'append_agent_note', () => {
      if (input.note.length > 4096) throw new Error('POLICY_VIOLATION: note too long');
      this.events.append(input.proof.runId, 'agent_note', input.principal.installationId, { note: input.note });
    });
  }

  requestConfirmation(input: {
    requestId: string; proof: LeaseProof; principal: AdapterPrincipal; stageRunId: string;
    type: string; summary: string; exactActionHash: string; ttlMs?: number;
  }): { id: string; nonce: string; expiresAt: string } {
    return this.leasedOnce(input, 'request_confirmation', 'ALREADY_REQUESTED', () => {
      const stage = this.requireStageForRun(input.stageRunId, input.proof.runId, 'running');
      const attempt = this.requireRunningAttempt(stage.latest_attempt_id, stage.id);
      const snapshot = this.db.prepare('SELECT safety_baseline_object_id FROM run_snapshots WHERE run_id=?')
        .get(input.proof.runId) as { safety_baseline_object_id: string };
      const result = new ConfirmationService(this.db, this.events, this.content).request({
        runId: input.proof.runId, stageRunId: stage.id, stageAttemptId: attempt.id, type: input.type, summary: input.summary,
        actionHash: input.exactActionHash, safetyBaselineObjectId: snapshot.safety_baseline_object_id,
        installationId: input.principal.installationId,
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      });
      this.db.prepare(`UPDATE stage_runs SET status='waiting_for_user',updated_at=? WHERE id=? AND status='running'`)
        .run(new Date().toISOString(), stage.id);
      const otherWork = this.db.prepare(`SELECT 1 FROM stage_runs WHERE run_id=? AND id<>?
        AND status IN ('ready','running') LIMIT 1`).get(input.proof.runId, stage.id);
      if (!otherWork) this.db.prepare(`UPDATE runs SET status='waiting_for_user',updated_at=? WHERE id=? AND status='running'`)
        .run(new Date().toISOString(), input.proof.runId);
      return result;
    });
  }

  recordArtifact(input: {
    requestId: string; proof: LeaseProof; principal: AdapterPrincipal; stageAttemptId: string; sourcePath: string;
    artifactType: 'document' | 'log' | 'test_evidence' | 'file_manifest' | 'ui_prototype' | 'deployment_record' | 'rollback_record' | 'other';
    summary: string; producerRoleVersionId: string; metadata?: unknown;
  }): { id: string; contentObjectId: string } {
    return this.leased(input, 'record_artifact', () => {
      this.requireAttemptForRun(input.stageAttemptId, input.proof.runId, 'running');
      const artifact = new EvidenceService(this.db, this.content).recordArtifact({
        runId: input.proof.runId, stageAttemptId: input.stageAttemptId, sourcePath: input.sourcePath,
        artifactType: input.artifactType, summary: input.summary, producerRoleVersionId: input.producerRoleVersionId,
        adapterContext: { canonicalProjectPath: input.principal.canonicalProjectPath },
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      this.events.append(input.proof.runId, 'artifact_recorded', 'server', { artifactId: artifact.id });
      return artifact;
    });
  }

  recordWorkspaceCheckpoint(input: {
    requestId: string; proof: LeaseProof; principal: AdapterPrincipal; stageAttemptId?: string;
    kind: 'run_start' | 'before_attempt' | 'progress' | 'after_attempt'; baselineFingerprint: string; state: WorkspaceState;
  }): { id: string; fingerprint: string } {
    return this.leased(input, 'record_workspace_checkpoint', () => {
      if (input.stageAttemptId !== undefined) this.requireAttemptForRun(input.stageAttemptId, input.proof.runId);
      const checkpoint = new EvidenceService(this.db, this.content).recordCheckpoint({
        runId: input.proof.runId, kind: input.kind, baselineFingerprint: input.baselineFingerprint, state: input.state,
        ...(input.stageAttemptId === undefined ? {} : { stageAttemptId: input.stageAttemptId }),
      });
      this.events.append(input.proof.runId, 'checkpoint_recorded', 'server', { checkpointId: checkpoint.id });
      return checkpoint;
    });
  }

  recordMemory(input: {
    requestId: string; proof: LeaseProof; principal: AdapterPrincipal; stageRunId: string;
    memoryType: MemoryType; scope: MemoryScope; title: string; summary: string; content: unknown;
    retentionPolicy: MemoryRetentionPolicy;
  }): { id: string; contentObjectId: string; deduplicated: boolean } {
    return this.leased(input, 'record_memory', () => {
      const memory = new MemoryService(this.db, this.content).record({
        runId: input.proof.runId, stageRunId: input.stageRunId, memoryType: input.memoryType,
        scope: input.scope, title: input.title, summary: input.summary, content: input.content,
        retentionPolicy: input.retentionPolicy,
      });
      if (!memory.deduplicated) {
        this.events.append(input.proof.runId, 'memory_recorded', 'server', { memoryId: memory.id }, input.stageRunId);
      }
      return memory;
    });
  }

  checkRecovery(
    runId: string,
    current: WorkspaceState,
    principal: Pick<AdapterPrincipal, 'installationId' | 'canonicalProjectPath'>,
  ): ReturnType<RecoveryService['check']> {
    this.requireRun(runId);
    return new RecoveryService(this.db, this.content).check(
      runId, current, this.recoveryContext(runId, principal),
    );
  }

  private leased<T>(
    input: { requestId: string; proof: LeaseProof; principal: AdapterPrincipal }, operation: string, work: () => T,
  ): T {
    const safeRequest = { ...input, proof: { ...input.proof, leaseToken: digest(input.proof.leaseToken) } };
    return this.command(input.principal.installationId, operation, input.requestId, safeRequest, () => {
      this.leases.validate(input.proof, input.principal);
      return work();
    });
  }

  private leasedOnce<T>(
    input: { requestId: string; proof: LeaseProof; principal: AdapterPrincipal }, operation: string,
    replayCode: string, work: () => T,
  ): T {
    const safeRequest = { ...input, proof: { ...input.proof, leaseToken: digest(input.proof.leaseToken) } };
    return this.db.transaction(() => {
      const begun = this.idem.begin(input.principal.installationId, operation, input.requestId, digest(safeRequest));
      if (begun.kind === 'replay') throw new Error(replayCode);
      this.leases.validate(input.proof, input.principal);
      const response = work();
      this.idem.complete(begun.id, { accepted: true });
      return response;
    }).immediate();
  }

  private command<T>(principal: string, operation: string, requestId: string, request: unknown, work: () => T): T {
    const requestHash = digest(request);
    try {
      return this.db.transaction(() => {
        const begun = this.idem.begin(principal, operation, requestId, requestHash);
        if (begun.kind === 'replay') return begun.response as T;
        const response = work();
        this.idem.complete(begun.id, response ?? null);
        return response;
      }).immediate();
    } catch (error) {
      if (!String(error).includes('IDEMPOTENCY_') && !String(error).includes('ALREADY_CLAIMED')) {
        try {
          this.db.transaction(() => {
            const begun = this.idem.begin(principal, operation, requestId, requestHash);
            if (begun.kind === 'new') this.idem.fail(begun.id, { message: error instanceof Error ? error.message : 'error' });
          }).immediate();
        } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  private createAttempt(stage: StageRunRow, expected: 'ready' | 'failed' | 'interrupted', input: unknown): { attemptId: string } {
    if (stage.status !== expected) throw new Error('INVALID_TRANSITION: begin attempt');
    assertStageTransition(expected, 'running');
    const row = this.db.prepare('SELECT coalesce(max(attempt_number),0)+1 AS n FROM stage_attempts WHERE stage_run_id=?')
      .get(stage.id) as { n: number };
    if (row.n > stage.max_attempts) throw new Error('POLICY_VIOLATION: attempts exhausted');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO stage_attempts(id,stage_run_id,attempt_number,status,input_envelope,started_at)
      VALUES(?,?,?,'running',?,?)`).run(id, stage.id, row.n, canonicalJson(input), now);
    const changed = this.db.prepare(`UPDATE stage_runs SET status='running',latest_attempt_id=?,updated_at=?,completed_at=NULL
      WHERE id=? AND run_id=? AND status=?`).run(id, now, stage.id, stage.run_id, expected);
    if (changed.changes !== 1) throw new Error('INVALID_TRANSITION: stage claim race');
    this.events.append(stage.run_id, expected === 'ready' ? 'stage_started' : 'stage_retried', 'server',
      { attemptId: id, attemptNumber: row.n }, stage.id);
    return { attemptId: id };
  }

  private applyFailurePolicy(runId: string, stage: StageRunRow, definition: WorkflowStage, code: string, summary: string): void {
    if (definition.failure_policy === 'pause') { this.pause(runId); return; }
    if (definition.failure_policy === 'trigger_iteration') {
      if (stage.iteration_group_key) {
        const now = new Date().toISOString();
        this.db.prepare(`UPDATE stage_runs SET status='cancelled',updated_at=?,completed_at=?
          WHERE run_id=? AND iteration_group_key=? AND iteration_number=? AND status IN ('queued','ready')`)
          .run(now, now, runId, stage.iteration_group_key, stage.iteration_number);
      }
      this.advanceIterations(runId, stage);
      this.refreshFrontier(runId);
      this.failRunIfExhausted(runId, code, summary);
      return;
    }
    if (definition.failure_policy === 'retry_then_fail') {
      const attempts = this.db.prepare('SELECT count(*) AS count FROM stage_attempts WHERE stage_run_id=?').get(stage.id) as { count: number };
      if (attempts.count < stage.max_attempts) {
        this.failRunIfExhausted(runId, code, summary);
        return;
      }
    }
    this.refreshFrontier(runId);
    this.failRunIfExhausted(runId, code, summary);
  }

  private advanceIterations(runId: string, changedStage: StageRunRow): void {
    if (!changedStage.iteration_group_key) return;
    const workflow = this.workflow(runId);
    const group = workflow.data.iteration_groups.find((candidate) => candidate.key === changedStage.iteration_group_key);
    if (!group) throw new Error('POLICY_VIOLATION: missing iteration group');
    const iteration = this.db.prepare(`SELECT id,iteration_number,status FROM run_iterations
      WHERE run_id=? AND group_key=? ORDER BY iteration_number DESC LIMIT 1`)
      .get(runId, group.key) as { id: string; iteration_number: number; status: 'running' | 'succeeded' | 'failed' } | undefined;
    if (!iteration || iteration.status !== 'running') return;
    const stages = this.runs.listStageRuns(runId)
      .filter((stage) => stage.iteration_group_key === group.key && stage.iteration_number === iteration.iteration_number);
    const gateStatuses: Record<string, string> = {};
    for (const key of group.gate_stage_keys) {
      const gate = stages.find((stage) => stage.stage_key === key);
      if (gate) gateStatuses[key] = gate.status;
    }
    const decision = reduceIteration(group, { iterationNumber: iteration.iteration_number, status: iteration.status }, gateStatuses);
    const now = new Date().toISOString();
    if (decision.markIteration !== undefined) {
      this.db.prepare('UPDATE run_iterations SET status=?,completed_at=? WHERE id=? AND status=?')
        .run(decision.markIteration, now, iteration.id, 'running');
    }
    if (decision.createIteration !== undefined) {
      this.db.prepare(`INSERT INTO run_iterations(id,run_id,group_key,iteration_number,status,created_at)
        VALUES(?,?,?,?,'running',?)`).run(randomUUID(), runId, group.key, decision.createIteration, now);
      for (const key of decision.createStageRuns) {
        const definition = workflow.data.stages.find((stage) => stage.key === key);
        if (!definition) throw new Error(`POLICY_VIOLATION: missing iteration stage ${key}`);
        this.insertStageRun(runId, definition, decision.createIteration,
          key === group.entry_stage_key ? 'ready' : 'queued', now);
      }
    }
  }

  private refreshFrontier(runId: string): void {
    const workflow = this.workflow(runId);
    const allRows = this.runs.listStageRuns(runId);
    const latestByKey = new Map<string, StageRunRow>();
    for (const row of allRows) {
      const current = latestByKey.get(row.stage_key);
      if (!current || row.iteration_number > current.iteration_number) latestByKey.set(row.stage_key, row);
    }
    const run = this.requireRun(runId);
    const outputs: Record<string, unknown> = {};
    for (const row of latestByKey.values()) {
      if (row.status !== 'succeeded' || !row.latest_attempt_id) continue;
      const attempt = this.db.prepare('SELECT output_envelope FROM stage_attempts WHERE id=?').get(row.latest_attempt_id) as { output_envelope: string | null } | undefined;
      if (attempt?.output_envelope) outputs[row.stage_key] = JSON.parse(attempt.output_envelope);
    }
    try {
      const frontier = deriveFrontier(workflow.data, [...latestByKey.values()].map((row) => ({
        stageKey: row.stage_key, status: row.status as StageStatus, iterationNumber: row.iteration_number,
      })), { input: JSON.parse(run.input_envelope) as unknown, outputs, constants: {} });
      const parallel = this.adapterCapabilities(runId).parallelSubagentIsolation;
      const selected = [...latestByKey.values()].some((row) => ['ready', 'running', 'waiting_for_user'].includes(row.status));
      const readyKeys = parallel || selected ? (parallel ? frontier.ready : []) : frontier.ready.slice(0, 1);
      for (const key of readyKeys) {
        const row = latestByKey.get(key);
        if (row?.status === 'queued') {
          this.db.prepare(`UPDATE stage_runs SET status='ready',updated_at=? WHERE id=? AND status='queued'`)
            .run(new Date().toISOString(), row.id);
          if (row.iteration_group_key) this.ensureIteration(runId, row.iteration_group_key, row.iteration_number, new Date().toISOString());
          this.events.append(runId, 'stage_ready', 'server', {}, row.id);
        }
      }
      for (const key of frontier.skipped) {
        const row = latestByKey.get(key);
        if (row?.status === 'queued') {
          this.finishStage(row.id, 'queued', 'skipped');
          this.events.append(runId, 'stage_skipped', 'server', {}, row.id);
        }
      }
    } catch (error) {
      const code = error instanceof Error && error.message.startsWith('CONDITION_EVALUATION_FAILED')
        ? 'CONDITION_EVALUATION_FAILED' : 'POLICY_VIOLATION';
      this.failRun(runId, code, error instanceof Error ? error.message : 'workflow evaluation failed', false);
    }
  }

  private failRunIfExhausted(runId: string, code: string, summary: string): void {
    const workflow = this.workflow(runId);
    const latestByKey = new Map<string, StageRunRow>();
    for (const stage of this.runs.listStageRuns(runId)) {
      const current = latestByKey.get(stage.stage_key);
      if (!current || stage.iteration_number > current.iteration_number) latestByKey.set(stage.stage_key, stage);
    }
    const stages = [...latestByKey.values()];
    const hasActive = stages.some((stage) => ['ready', 'running', 'waiting_for_user'].includes(stage.status));
    if (hasActive) return;
    const requiredIncomplete = stages.some((stage) => {
      const definition = workflow.data.stages.find((candidate) => candidate.key === stage.stage_key);
      return definition !== undefined && (!definition.optional || definition.mandatory_gate)
        && stage.status !== 'succeeded';
    });
    if (!requiredIncomplete) return;
    const hasLocalRetry = stages.some((stage) => {
      if (!['failed', 'interrupted'].includes(stage.status)) return false;
      const definition = workflow.data.stages.find((candidate) => candidate.key === stage.stage_key);
      if (stage.status === 'failed' && definition?.failure_policy !== 'pause') return false;
      const attempts = this.db.prepare('SELECT count(*) AS count FROM stage_attempts WHERE stage_run_id=?')
        .get(stage.id) as { count: number };
      return attempts.count < stage.max_attempts;
    });
    if (hasLocalRetry) return;
    const hasRetry = stages.some((stage) => {
      if (!['failed', 'interrupted'].includes(stage.status)) return false;
      const definition = workflow.data.stages.find((candidate) => candidate.key === stage.stage_key);
      if (definition?.failure_policy !== 'retry_then_fail') return false;
      const attempts = this.db.prepare('SELECT count(*) AS count FROM stage_attempts WHERE stage_run_id=?').get(stage.id) as { count: number };
      return attempts.count < stage.max_attempts;
    });
    if (!hasRetry) {
      this.db.prepare(`UPDATE run_iterations SET status='failed',completed_at=? WHERE run_id=? AND status='running'`)
        .run(new Date().toISOString(), runId);
    }
    this.failRun(runId, code, summary, hasRetry);
  }

  private failRun(runId: string, code: string, summary: string, retryable: boolean): void {
    const run = this.requireRun(runId);
    if (['failed', 'cancelled', 'completed'].includes(run.status)) return;
    assertRunTransition(run.status as RunStatus, 'failed');
    this.db.prepare(`UPDATE runs SET status='failed',failure_code=?,failure_summary=?,is_retryable=?,
      lease_token_hash=NULL,lease_expires_at=NULL,lease_holder_session_id=NULL,updated_at=? WHERE id=? AND status=?`)
      .run(code, summary, retryable ? 1 : 0, new Date().toISOString(), run.id, run.status);
    this.events.append(run.id, 'run_failed', 'server', { errorCode: code });
  }

  private pause(runId: string): void {
    const run = this.requireRun(runId);
    assertRunTransition(run.status as RunStatus, 'paused');
    this.db.prepare(`UPDATE runs SET status='paused',lease_token_hash=NULL,lease_expires_at=NULL,
      lease_holder_session_id=NULL,updated_at=? WHERE id=? AND status=?`).run(new Date().toISOString(), run.id, run.status);
    this.events.append(run.id, 'run_paused', 'server', {});
  }

  private assertSnapshotCompatible(runId: string, installationId: string): void {
    const snapshot = this.db.prepare(`SELECT adapter_capability_object_id,rule_bundle_object_id,safety_baseline_object_id
      FROM run_snapshots WHERE run_id=?`).get(runId) as {
      adapter_capability_object_id: string; rule_bundle_object_id: string; safety_baseline_object_id: string;
    } | undefined;
    const installation = this.db.prepare(`SELECT capability_object_id,status FROM client_installations WHERE id=?`)
      .get(installationId) as { capability_object_id: string; status: string } | undefined;
    const currentRule = this.content.putCanonicalJson(this.#ruleBundle);
    const currentSafety = this.content.putCanonicalJson(this.#safetyBaseline);
    if (!snapshot || installation?.status !== 'active' || installation.capability_object_id !== snapshot.adapter_capability_object_id
      || currentRule.id !== snapshot.rule_bundle_object_id || currentSafety.id !== snapshot.safety_baseline_object_id) {
      throw new Error('ADAPTER_INCOMPATIBLE');
    }
    for (const id of [snapshot.adapter_capability_object_id, snapshot.rule_bundle_object_id, snapshot.safety_baseline_object_id]) this.content.verify(id);
    const revoked = this.db.prepare(`SELECT 1 FROM stage_runs s JOIN role_versions r ON r.id=s.role_version_id
      WHERE s.run_id=? AND r.status!='published' LIMIT 1`).get(runId);
    if (revoked) throw new Error('POLICY_VIOLATION: role version revoked');
  }

  private recoveryContext(
    runId: string,
    principal: Pick<AdapterPrincipal, 'installationId' | 'canonicalProjectPath'>,
  ): Parameters<RecoveryService['check']>[2] {
    const installation = this.db.prepare("SELECT capability_object_id FROM client_installations WHERE id=? AND status='active'")
      .get(principal.installationId) as { capability_object_id: string } | undefined;
    if (!installation) throw new Error('ADAPTER_INCOMPATIBLE');
    return {
      canonicalProjectPath: principal.canonicalProjectPath,
      ruleBundleObjectId: this.content.putCanonicalJson(this.#ruleBundle).id,
      safetyBaselineObjectId: this.content.putCanonicalJson(this.#safetyBaseline).id,
      adapterCapabilityObjectId: installation.capability_object_id,
    };
  }

  private sameCanonicalProject(databasePath: string, adapterPath: string): boolean {
    try {
      if (!isAbsolute(databasePath) || !isAbsolute(adapterPath)) return false;
      const databaseStats = lstatSync(databasePath);
      const adapterStats = lstatSync(adapterPath);
      if (databaseStats.isSymbolicLink() || adapterStats.isSymbolicLink()
        || !databaseStats.isDirectory() || !adapterStats.isDirectory()) return false;
      const databaseRoot = realpathSync(databasePath);
      const adapterRoot = realpathSync(adapterPath);
      return databaseRoot === resolve(databasePath) && adapterRoot === resolve(adapterPath) && databaseRoot === adapterRoot;
    } catch {
      return false;
    }
  }

  private validateReferencedContent(ids: readonly string[]): void {
    for (const id of ids) this.content.verify(id);
  }

  private adapterCapabilities(runId: string): { parallelSubagentIsolation: boolean } {
    const snapshot = this.db.prepare('SELECT adapter_capability_object_id FROM run_snapshots WHERE run_id=?')
      .get(runId) as { adapter_capability_object_id: string } | undefined;
    if (!snapshot) throw new Error('NOT_FOUND: snapshot');
    this.content.verify(snapshot.adapter_capability_object_id);
    const value = this.readJson<unknown>(snapshot.adapter_capability_object_id);
    const capability = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
    return { parallelSubagentIsolation: capability['parallelSubagentIsolation'] === true };
  }

  private ensureIteration(runId: string, groupKey: string, iterationNumber: number, now: string): void {
    const group = this.workflow(runId).data.iteration_groups.find((candidate) => candidate.key === groupKey);
    if (!group || iterationNumber < 1 || iterationNumber > group.max_iterations) {
      throw new Error('POLICY_VIOLATION: invalid iteration activation');
    }
    this.db.prepare(`INSERT INTO run_iterations(id,run_id,group_key,iteration_number,status,created_at)
      VALUES(?,?,?,?,'running',?) ON CONFLICT(run_id,group_key,iteration_number) DO NOTHING`)
      .run(randomUUID(), runId, groupKey, iterationNumber, now);
  }

  private hasConsumedConfirmation(runId: string, stageRunId: string, attemptId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM confirmation_requests WHERE run_id=? AND stage_run_id=?
      AND stage_attempt_id=? AND status='consumed' LIMIT 1`).get(runId, stageRunId, attemptId) !== undefined;
  }

  private frozenRole(runId: string, roleVersionId: string): RoleVersionEnvelope {
    const snapshot = this.db.prepare('SELECT role_bundle_object_id FROM run_snapshots WHERE run_id=?')
      .get(runId) as { role_bundle_object_id: string } | undefined;
    if (!snapshot) throw new Error('NOT_FOUND: snapshot');
    this.content.verify(snapshot.role_bundle_object_id);
    const bundle = this.readJson<FrozenRoleBundle>(snapshot.role_bundle_object_id);
    const role = bundle.roles.find((candidate) => candidate.roleVersionId === roleVersionId)?.envelope;
    if (!role) throw new Error(`POLICY_VIOLATION: role ${roleVersionId} missing from frozen bundle`);
    return role;
  }

  private validateFrozenRoleContract(
    runId: string, roleVersionId: string, output: StageOutputEnvelope, artifacts: readonly ArtifactRow[],
  ): void {
    const role = this.frozenRole(runId, roleVersionId);
    for (const artifact of artifacts) this.content.verify(artifact.content_object_id);
    const outputSchema = role.data.output_schema.data;
    if (outputSchema !== null && typeof outputSchema === 'object' && !Array.isArray(outputSchema)
      && Object.keys(outputSchema as Record<string, unknown>).length > 0) {
      this.#validator.check(outputSchema as Parameters<ContractValidator['check']>[0], output.data);
    }
    const contract = role.data.completion_contract.data;
    if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) {
      throw new Error('POLICY_VIOLATION: invalid frozen completion contract');
    }
    const value = contract as Record<string, unknown>;
    const validateRequirements = (key: 'required_artifacts' | 'required_evidence', referenced: readonly string[]): void => {
      const raw = value[key] ?? [];
      if (!Array.isArray(raw)) throw new Error('POLICY_VIOLATION: invalid frozen completion contract');
      const requirements = raw as CompletionRequirement[];
      const selected = new Set(referenced);
      for (const requirement of requirements) {
        if (!requirement || typeof requirement.artifact_type !== 'string'
          || !Number.isInteger(requirement.min_count) || requirement.min_count < 1) {
          throw new Error('POLICY_VIOLATION: invalid frozen completion contract');
        }
        const count = artifacts.filter((artifact) => selected.has(artifact.content_object_id)
          && artifact.artifact_type === requirement.artifact_type).length;
        if (count < requirement.min_count) {
          throw new Error(`POLICY_VIOLATION: completion contract requires ${requirement.min_count} ${key} of type ${requirement.artifact_type}`);
        }
      }
    };
    validateRequirements('required_artifacts', output.data.artifact_object_ids);
    validateRequirements('required_evidence', output.data.evidence_object_ids);
  }

  private insertStageRun(runId: string, stage: WorkflowStage, iteration: number, status: 'queued' | 'ready', now: string): void {
    this.db.prepare(`INSERT INTO stage_runs
      (id,run_id,stage_key,iteration_group_key,iteration_number,role_version_id,status,max_attempts,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), runId, stage.key, stage.iteration_group_key ?? null, iteration,
        stage.role_version_id, status, stage.max_attempts, now, now);
  }

  private finishStage(id: string, expected: string, next: 'skipped' | 'cancelled'): void {
    assertStageTransition(expected as StageStatus, next);
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE stage_runs SET status=?,updated_at=?,completed_at=? WHERE id=? AND status=?`)
      .run(next, now, now, id, expected);
    if (result.changes !== 1) throw new Error(`INVALID_TRANSITION: stage ${expected} -> ${next}`);
  }

  private requireRun(id: string): RunRecord {
    const run = this.runs.getRun(id);
    if (!run) throw new Error(`NOT_FOUND: run ${id}`);
    return run;
  }

  private requireStageForRun(id: string, runId: string, status?: string): StageRunRow {
    const stage = this.runs.getStageRun(id);
    if (!stage || stage.run_id !== runId) throw new Error('POLICY_VIOLATION: stage does not belong to run');
    if (status !== undefined && stage.status !== status) throw new Error('INVALID_TRANSITION: stage state');
    return stage;
  }

  private requireRunningAttempt(id: string | null, stageRunId: string): AttemptRow {
    if (!id) throw new Error('INVALID_TRANSITION: missing attempt');
    const attempt = this.db.prepare(`SELECT id,stage_run_id,attempt_number,status FROM stage_attempts WHERE id=?`)
      .get(id) as AttemptRow | undefined;
    if (!attempt || attempt.stage_run_id !== stageRunId || attempt.status !== 'running') throw new Error('INVALID_TRANSITION: attempt');
    return attempt;
  }

  private requireAttemptForRun(id: string, runId: string, status?: string): AttemptRow {
    const attempt = this.db.prepare(`SELECT a.id,a.stage_run_id,a.attempt_number,a.status FROM stage_attempts a
      JOIN stage_runs s ON s.id=a.stage_run_id WHERE a.id=? AND s.run_id=?`).get(id, runId) as AttemptRow | undefined;
    if (!attempt) throw new Error('POLICY_VIOLATION: attempt does not belong to run');
    if (status !== undefined && attempt.status !== status) throw new Error('INVALID_TRANSITION: attempt state');
    return attempt;
  }

  private definition(runId: string, stageKey: string): WorkflowStage {
    const definition = this.workflow(runId).data.stages.find((stage) => stage.key === stageKey);
    if (!definition) throw new Error(`POLICY_VIOLATION: missing stage definition ${stageKey}`);
    return definition;
  }

  private workflow(runId: string): WorkflowVersionEnvelope {
    const row = this.db.prepare('SELECT workflow_object_id FROM run_snapshots WHERE run_id=?').get(runId) as { workflow_object_id: string } | undefined;
    if (!row) throw new Error('NOT_FOUND: snapshot');
    return this.readJson<WorkflowVersionEnvelope>(row.workflow_object_id);
  }

  private readJson<T>(objectId: string): T {
    return JSON.parse(Buffer.from(this.content.read(objectId)).toString('utf8')) as T;
  }
}
