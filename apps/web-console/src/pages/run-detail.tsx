import { Fragment, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useApi } from "../api/context";
import { subscribeToRunEvents } from "../api/events";
import type { RunEvent } from "../api/types";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { useLoad } from "./use-load";
import { useI18n } from "../i18n";
import { WorkflowCanvas } from "../components/workflow-canvas";
import { CanvasDrawer } from "../components/canvas-drawer";
const tabs = ["overview", "timeline", "stages", "artifacts", "files", "tests", "memory", "diagnostics"] as const;
const value = (row: Record<string, unknown>, key: string) =>
  String(row[key] ?? "—");
const payload = (event: RunEvent) =>
  typeof event.payload_envelope === "string"
    ? (() => {
        try {
          return JSON.parse(event.payload_envelope) as Record<string, unknown>;
        } catch {
          return { raw: event.payload_envelope };
        }
      })()
    : event.payload_envelope;
export function RunDetailPage() {
  const { t, locale } = useI18n();
  const { id = "" } = useParams(),
    api = useApi(),
    { data, error } = useLoad(() => api.runs.get(id), [api, id]);
  const [tab, setTab] = useState<(typeof tabs)[number]>("overview"),
    [live, setLive] = useState<RunEvent[]>([]),
    [selectedStage, setSelectedStage] = useState<string>(),
    [showWholeWorkflow, setShowWholeWorkflow] = useState(false);
  const workflow = useLoad(
    () => data ? api.workflows.getVersion(data.workflow_version_id) : Promise.resolve(undefined),
    [api, data?.workflow_version_id],
  );
  useEffect(
    () =>
      subscribeToRunEvents({
        api,
        runId: id,
        onEvent: (event) =>
          setLive((current) =>
            current.some((e) => e.sequence_number === event.sequence_number)
              ? current
              : [...current, event],
          ),
      }),
    [api, id],
  );
  if (error)
    return (
      <div className="page">
        <h1 tabIndex={-1}>{t("runDetail")}</h1>
        <ErrorPanel error={error} />
      </div>
    );
  if (!data)
    return (
      <div className="page">
        <h1 tabIndex={-1}>{t("runDetail")}</h1>
        <p role="status">{t("runSnapshot")}</p>
      </div>
    );
  const events = [...data.events, ...live]
    .filter(
      (event, index, all) =>
        all.findIndex((e) => e.sequence_number === event.sequence_number) ===
        index,
    )
    .sort((a, b) => a.sequence_number - b.sequence_number);
  const waiting =
    data.status === "waiting_for_user" ||
    data.confirmations.some((c) => value(c, "status") === "pending");
  const unknown = data.side_effects.some(
    (op) => value(op, "status") === "unknown",
  );
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">
            {data.origin_client_type} · {data.project_name ?? data.project_id}
          </span>
          <h1 tabIndex={-1}>{data.objective}</h1>
          <p className="muted">
            {t("runId")} {data.id} · {t("workflowSnapshot")} {data.workflow_version_id}
          </p>
        </div>
        <Badge>{data.status}</Badge>
      </div>
      {waiting && (
        <div className="notice">
          {t("confirmInSession")}
        </div>
      )}
      {data.status === "failed" && (
        <div className="notice danger">
          <strong>{data.failure_code ?? t("stageFailed")}</strong> ·{" "}
          {data.failure_summary ?? t("checkEvidence")}{" "}
          {t("retryInSession")}
        </div>
      )}
      {data.status === "interrupted" && (
        <div className="notice danger">
          {t("sessionInterrupted")}
        </div>
      )}
      {unknown && (
        <div className="notice danger">
          {t("sideEffectUnknown")}
        </div>
      )}
      <div className="tabs" role="tablist" aria-label={t("runDetail")}>
        {tabs.map((name) => (
          <button
            className="tab"
            role="tab"
            aria-selected={tab === name}
            key={name}
            onClick={() => setTab(name)}
          >
            {t(name)}
          </button>
        ))}
      </div>
      {selectedStage && <CanvasDrawer title={t("nodeSettings")} onClose={() => setSelectedStage(undefined)} className="run-node-inspector">
        <p className="muted">{t(selectedStage)}</p>
        <p><strong>{t("status")}</strong> · {value(data.stages.find((stage) => value(stage, "stage_key") === selectedStage) ?? {}, "status")}</p>
        <p><strong>{t("iteration")}</strong> · {value(data.stages.find((stage) => value(stage, "stage_key") === selectedStage) ?? {}, "iteration_number")}</p>
        {data.status === "waiting_for_user" ? <p className="notice">{t("confirmInSession")}</p> : null}
        {data.status === "failed" ? <p className="notice danger">{t("retryInSession")}</p> : null}
      </CanvasDrawer>}
      <section role="tabpanel">
        {tab === "overview" && (
          <div className="grid">
            <article className="span-12 run-canvas-card">
              <div className="run-canvas-head"><div><span className="eyebrow">{t("readonlyEvidence")}</span><h2>{t("runCanvas")}</h2><p className="muted">{t("runCanvasDescription")}</p></div><button className="button ghost" type="button" onClick={() => setShowWholeWorkflow((current) => !current)}>{showWholeWorkflow ? t("runCanvas") : t("viewWholeWorkflow")}</button></div>
              {!showWholeWorkflow && <div className="current-focus"><strong>{t("currentFocus")}</strong><span>{data.active_stages.length ? data.active_stages.map(t).join(" · ") : t("noActiveStage")}</span></div>}
              {workflow.data ? <WorkflowCanvas
                readonly
                envelope={workflow.data.envelope}
                roles={[]}
                label={t}
                onSelect={setSelectedStage}
                stageStates={Object.fromEntries(data.stages.map((stage) => [value(stage, "stage_key"), value(stage, "status")]))}
              /> : <p className="muted">{workflow.error ? t("workflowSnapshotUnavailable") : t("loading")}</p>}
            </article>
            <article className="card span-7">
              <h2>{t("activeStages")}</h2>
              <div className="stage-pills">
                {data.active_stages.length ? (
                  data.active_stages.map((stage) => (
                    <Badge key={stage}>{stage}</Badge>
                  ))
                ) : (
                  <span className="muted">{t("noActiveStage")}</span>
                )}
              </div>
              <h2 className="mt-24">{t("stageStatus")}</h2>
              {data.stages.length ? (
                <div className="stage-list">
                  {data.stages.map((stage) => (
                    <div className="system-row" key={value(stage, "id")}>
                      <span>
                        <strong>{value(stage, "stage_key")}</strong>
                        <small className="block">
                          {t("iteration")} {value(stage, "iteration_number")} · {t("roles")}{" "}
                          {value(stage, "role_version_id")}
                        </small>
                      </span>
                      <Badge>{value(stage, "status")}</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState />
              )}
            </article>
            <aside className="card span-5">
              <h2>{t("frozenSnapshot")}</h2>
              <dl className="kv">
                {Object.entries(data.snapshot ?? {}).map(([key, v]) => (
                  <Fragment key={key}>
                    <dt>{key}</dt>
                    <dd>{String(v)}</dd>
                  </Fragment>
                ))}
              </dl>
            </aside>
          </div>
        )}
        {tab === "timeline" && (
          <article className="card">
            <h2>{t("eventTimeline")}</h2>
            {events.length ? (
              <ol className="timeline">
                {events.map((event) => (
                  <li key={event.sequence_number}>
                    <strong>
                      #{event.sequence_number} · {event.event_type}
                    </strong>
                    <time>{new Date(event.created_at).toLocaleString(locale)}</time>
                    <pre className="json">
                      {JSON.stringify(payload(event), null, 2)}
                    </pre>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState />
            )}
          </article>
        )}
        {tab === "stages" && (
          <div className="grid">
            <article className="card span-7">
              <h2>{t("attemptHistory")}</h2>
              {data.attempts.length ? (
                data.attempts.map((attempt) => (
                  <div className="stage" key={value(attempt, "id")}>
                    <div className="stage-head">
                      <strong>
                        {t("attempt")} #{value(attempt, "attempt_number")}
                      </strong>
                      <Badge>{value(attempt, "status")}</Badge>
                    </div>
                    <p className="muted">
                      {value(attempt, "started_at")} →{" "}
                      {value(attempt, "completed_at")}
                    </p>
                    {value(attempt, "failure_summary") !== "—" && (
                      <p>
                        {value(attempt, "failure_code")} ·{" "}
                        {value(attempt, "failure_summary")}
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <EmptyState />
              )}
            </article>
            <aside className="card span-5">
              <h2>{t("iterations")}</h2>
              {data.iterations.length ? (
                data.iterations.map((iteration) => (
                  <div className="system-row" key={value(iteration, "id")}>
                    <span>
                      {value(iteration, "group_key")} · {t("iteration")} {value(iteration, "iteration_number")}
                    </span>
                    <Badge>{value(iteration, "status")}</Badge>
                  </div>
                ))
              ) : (
                <EmptyState />
              )}
            </aside>
          </div>
        )}
        {tab === "artifacts" && (
          <article className="card">
            <h2>{t("safeDownload")}</h2>
            <p className="muted">
              {t("safeDownloadDescription")}
            </p>
            {data.artifacts.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("type")}</th>
                      <th>{t("summary")}</th>
                      <th>{t("sourceFile")}</th>
                      <th>{t("recordedAt")}</th>
                      <th>{t("attachment")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.artifacts.map((item) => (
                      <tr key={item.id}>
                        <td>{item.artifact_type}</td>
                        <td>{item.summary}</td>
                        <td>{item.source_path ?? "—"}</td>
                        <td>{new Date(item.created_at).toLocaleString(locale)}</td>
                        <td>
                          <a
                            className="button"
                            href={api.artifacts.downloadUrl(item.id)}
                            download
                          >
                            下载
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState />
            )}
          </article>
        )}
        {tab === "files" && (
          <article className="card">
            <h2>{t("changedFiles")}</h2>
            {data.attempts.filter((a) => a.changed_files_object_id).length ? (
              data.attempts
                .filter((a) => a.changed_files_object_id)
                .map((a) => (
                  <div className="stage" key={value(a, "id")}>
                    <strong>{t("attempt")} #{value(a, "attempt_number")}</strong>
                    <pre className="json">
                      {a.changed_files
                        ? JSON.stringify(a.changed_files, null, 2)
                        : `${value(a, "changed_files_object_id")} · ${value(a, "changed_files_error")}`}
                    </pre>
                  </div>
                ))
            ) : (
              <EmptyState detail={t("noDataDetail")} />
            )}
          </article>
        )}
        {tab === "tests" && (
          <article className="card">
            <h2>{t("testEvidence")}</h2>
            {data.artifacts.filter((a) => a.artifact_type === "test_evidence")
              .length ? (
              data.artifacts
                .filter((a) => a.artifact_type === "test_evidence")
                .map((a) => (
                  <div className="system-row" key={a.id}>
                    <span>
                      <strong>{a.summary}</strong>
                      <small className="block">{a.source_path ?? a.id}</small>
                    </span>
                    <a
                      className="button"
                      href={api.artifacts.downloadUrl(a.id)}
                      download
                    >
                      下载证据
                    </a>
                  </div>
                ))
            ) : (
              <EmptyState detail={t("noDataDetail")} />
            )}
          </article>
        )}
        {tab === "memory" && (
          <article className="card">
            <h2>{t("memoryRecords")}</h2>
            {data.memories.length ? (
              data.memories.map((m) => (
                <div className="stage" key={m.id}>
                  <strong>{m.title}</strong>
                  <p>{m.summary}</p>
                  <small>
                    {m.memory_type} · {m.scope}
                  </small>
                </div>
              ))
            ) : (
              <EmptyState />
            )}
          </article>
        )}
        {tab === "diagnostics" && (
          <div className="grid">
            <article className="card span-6">
              <h2>{t("waitingConfirmation")}</h2>
              {data.confirmations.length ? (
                data.confirmations.map((c) => (
                  <pre className="json" key={value(c, "id")}>
                    {JSON.stringify(c, null, 2)}
                  </pre>
                ))
              ) : (
                <EmptyState />
              )}
            </article>
            <article className="card span-6">
              <h2>{t("diagnosticEvidence")}</h2>
              {data.side_effects.length ? (
                data.side_effects.map((op) => (
                  <pre className="json" key={value(op, "id")}>
                    {JSON.stringify(op, null, 2)}
                  </pre>
                ))
              ) : (
                <EmptyState />
              )}
            </article>
          </div>
        )}
      </section>
    </div>
  );
}
