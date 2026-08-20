import { Link } from "react-router-dom";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { useApi } from "../api/context";
import { useLoad } from "./use-load";
export function OverviewPage() {
  const api = useApi();
  const { data: system, error } = useLoad(
    () => api.system.diagnostics(),
    [api],
  );
  const { data: runs } = useLoad(() => api.runs.list(), [api]);
  if (error)
    return (
      <div className="page">
        <h1 tabIndex={-1}>总览</h1>
        <ErrorPanel error={error} />
      </div>
    );
  const recent = runs?.slice(0, 5) ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Local orchestration</span>
          <h1 tabIndex={-1}>工作台总览</h1>
          <p className="muted">
            只在本机编排未来版本，并观察 Agent 会话产生的任务记录。
          </p>
        </div>
        {system && <Badge>{system.status}</Badge>}
      </div>
      <div className="grid">
        <div className="card stat span-3">
          <strong>
            {Object.values(system?.run_counts ?? {}).reduce((a, b) => a + b, 0)}
          </strong>
          <span>全部 Runs</span>
        </div>
        <div className="card stat span-3">
          <strong>{system?.run_counts.running ?? 0}</strong>
          <span>执行中</span>
        </div>
        <div className="card stat span-3">
          <strong>{system?.run_counts.waiting_for_user ?? 0}</strong>
          <span>等待会话确认</span>
        </div>
        <div className="card stat span-3">
          <strong>{system?.adapters.length ?? 0}</strong>
          <span>已登记 Adapter</span>
        </div>
        <section className="card span-8">
          <div className="page-head">
            <h2>最近 Runs</h2>
            <Link className="row-link" to="/runs">
              查看全部 →
            </Link>
          </div>
          {recent.length ? (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>目标</th>
                    <th>来源</th>
                    <th>当前阶段集合</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <Link className="row-link" to={`/runs/${run.id}`}>
                          {run.objective}
                        </Link>
                      </td>
                      <td>{run.origin_client_type}</td>
                      <td>
                        <div className="stage-pills">
                          {run.active_stages.map((s) => (
                            <Badge key={s}>{s}</Badge>
                          ))}
                        </div>
                      </td>
                      <td>
                        <Badge>{run.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="还没有 Run"
              detail="请从 Codex 或 Claude 会话发起任务。"
            />
          )}
        </section>
        <section className="card span-4">
          <h2>本机服务</h2>
          <dl className="kv">
            <dt>Web listener</dt>
            <dd>{system?.web_listener ?? "读取中…"}</dd>
            <dt>SQLite</dt>
            <dd>{system?.database_path ?? "读取中…"}</dd>
            <dt>CAS</dt>
            <dd>{system?.cas_status ?? "读取中…"}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
