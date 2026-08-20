import { Fragment, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useApi } from "../api/context";
import { subscribeToRunEvents } from "../api/events";
import type { RunEvent } from "../api/types";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { useLoad } from "./use-load";
const tabs = [
  "概览",
  "时间线",
  "阶段 / Attempts",
  "产物",
  "文件变化",
  "测试",
  "记忆",
  "诊断",
] as const;
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
  const { id = "" } = useParams(),
    api = useApi(),
    { data, error } = useLoad(() => api.runs.get(id), [api, id]);
  const [tab, setTab] = useState<(typeof tabs)[number]>("概览"),
    [live, setLive] = useState<RunEvent[]>([]);
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
        <h1 tabIndex={-1}>Run 详情</h1>
        <ErrorPanel error={error} />
      </div>
    );
  if (!data)
    return (
      <div className="page">
        <h1 tabIndex={-1}>Run 详情</h1>
        <p role="status">读取任务快照…</p>
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
            Run {data.id} · 模板快照 {data.workflow_version_id}
          </p>
        </div>
        <Badge>{data.status}</Badge>
      </div>
      {waiting && (
        <div className="notice">
          请回到发起本次任务的 Codex/Claude 会话完成确认。
        </div>
      )}
      {data.status === "failed" && (
        <div className="notice danger">
          <strong>{data.failure_code ?? "阶段失败"}</strong> ·{" "}
          {data.failure_summary ?? "查看失败 Attempt 与证据。"}{" "}
          请回原客户端会话重试。
        </div>
      )}
      {data.status === "interrupted" && (
        <div className="notice danger">
          原会话已中断。Web 保留全部状态；请回同一客户端安装实例恢复。
        </div>
      )}
      {unknown && (
        <div className="notice danger">
          外部副作用结果未知：先在原会话对账，禁止直接重试。
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Run 详情分区">
        {tabs.map((name) => (
          <button
            className="tab"
            role="tab"
            aria-selected={tab === name}
            key={name}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <section role="tabpanel">
        {tab === "概览" && (
          <div className="grid">
            <article className="card span-7">
              <h2>当前阶段集合</h2>
              <div className="stage-pills">
                {data.active_stages.length ? (
                  data.active_stages.map((stage) => (
                    <Badge key={stage}>{stage}</Badge>
                  ))
                ) : (
                  <span className="muted">没有 active StageRun</span>
                )}
              </div>
              <h2 className="mt-24">阶段状态</h2>
              {data.stages.length ? (
                <div className="stage-list">
                  {data.stages.map((stage) => (
                    <div className="system-row" key={value(stage, "id")}>
                      <span>
                        <strong>{value(stage, "stage_key")}</strong>
                        <small className="block">
                          iteration {value(stage, "iteration_number")} · role{" "}
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
              <h2>冻结快照</h2>
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
        {tab === "时间线" && (
          <article className="card">
            <h2>事件时间线 · SSE 自动补齐</h2>
            {events.length ? (
              <ol className="timeline">
                {events.map((event) => (
                  <li key={event.sequence_number}>
                    <strong>
                      #{event.sequence_number} · {event.event_type}
                    </strong>
                    <time>{new Date(event.created_at).toLocaleString()}</time>
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
        {tab === "阶段 / Attempts" && (
          <div className="grid">
            <article className="card span-7">
              <h2>尝试历史</h2>
              {data.attempts.length ? (
                data.attempts.map((attempt) => (
                  <div className="stage" key={value(attempt, "id")}>
                    <div className="stage-head">
                      <strong>
                        Attempt #{value(attempt, "attempt_number")}
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
              <h2>迭代历史</h2>
              {data.iterations.length ? (
                data.iterations.map((iteration) => (
                  <div className="system-row" key={value(iteration, "id")}>
                    <span>
                      {value(iteration, "group_key")} · 第{" "}
                      {value(iteration, "iteration_number")} 轮
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
        {tab === "产物" && (
          <article className="card">
            <h2>安全下载</h2>
            <p className="muted">
              主动内容只作为附件下载，不在凭证页面内执行。
            </p>
            {data.artifacts.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>摘要</th>
                      <th>来源文件</th>
                      <th>记录时间</th>
                      <th>附件</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.artifacts.map((item) => (
                      <tr key={item.id}>
                        <td>{item.artifact_type}</td>
                        <td>{item.summary}</td>
                        <td>{item.source_path ?? "—"}</td>
                        <td>{new Date(item.created_at).toLocaleString()}</td>
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
        {tab === "文件变化" && (
          <article className="card">
            <h2>文件清单与工作区检查点</h2>
            {data.attempts.filter((a) => a.changed_files_object_id).length ? (
              data.attempts
                .filter((a) => a.changed_files_object_id)
                .map((a) => (
                  <div className="stage" key={value(a, "id")}>
                    <strong>Attempt #{value(a, "attempt_number")}</strong>
                    <pre className="json">
                      {a.changed_files
                        ? JSON.stringify(a.changed_files, null, 2)
                        : `${value(a, "changed_files_object_id")} · ${value(a, "changed_files_error")}`}
                    </pre>
                  </div>
                ))
            ) : (
              <EmptyState detail="未记录 changed files manifest。" />
            )}
          </article>
        )}
        {tab === "测试" && (
          <article className="card">
            <h2>测试证据</h2>
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
              <EmptyState detail="还没有冻结的测试证据。" />
            )}
          </article>
        )}
        {tab === "记忆" && (
          <article className="card">
            <h2>本 Run 产生的记忆</h2>
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
        {tab === "诊断" && (
          <div className="grid">
            <article className="card span-6">
              <h2>确认记录</h2>
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
              <h2>副作用记录</h2>
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
