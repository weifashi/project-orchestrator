import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/context";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { useLoad } from "./use-load";
const filterFields: ReadonlyArray<readonly [string, string]> = [
  ["project_id", "项目"],
  ["origin_client_type", "来源客户端"],
  ["status", "状态"],
  ["template", "模板"],
  ["date", "日期"],
];
export function RunListPage() {
  const api = useApi(),
    [filters, setFilters] = useState<Record<string, string>>({});
  const { data, error } = useLoad(
    () => api.runs.list(filters),
    [api, JSON.stringify(filters)],
  );
  const change = (key: string, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Read only evidence</span>
          <h1 tabIndex={-1}>Runs</h1>
          <p className="muted">
            当前阶段由 StageRun 状态推导，不存在可被页面改写的“当前阶段”字段。
          </p>
        </div>
        <button className="button" onClick={() => window.print()}>
          导出只读报告
        </button>
      </div>
      <section className="card mb-16">
        <h2>筛选</h2>
        <div className="filters">
          {filterFields.map(([key, label]) => (
            <label className="field" key={key}>
              <span>{label}</span>
              {key === "date" ? (
                <input
                  type="date"
                  value={filters[key] ?? ""}
                  onChange={(e) => change(key, e.target.value)}
                />
              ) : (
                <input
                  value={filters[key] ?? ""}
                  onChange={(e) => change(key, e.target.value)}
                  placeholder={`筛选${label}`}
                />
              )}
            </label>
          ))}
        </div>
      </section>
      {error ? (
        <ErrorPanel error={error} />
      ) : !data?.length ? (
        <EmptyState
          title="没有匹配的 Run"
          detail="调整筛选，或从 Codex / Claude 会话发起任务。"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>目标 / 项目</th>
                <th>来源</th>
                <th>模板</th>
                <th>当前阶段集合</th>
                <th>状态</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {data.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link className="row-link" to={`/runs/${run.id}`}>
                      {run.objective}
                    </Link>
                    <br />
                    <small>{run.project_name ?? run.project_id}</small>
                  </td>
                  <td>{run.origin_client_type}</td>
                  <td>{run.workflow_name ?? run.workflow_version_id}</td>
                  <td>
                    <div className="stage-pills">
                      {run.active_stages.length ? (
                        run.active_stages.map((stage) => (
                          <Badge key={stage}>{stage}</Badge>
                        ))
                      ) : (
                        <span>—</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <Badge>{run.status}</Badge>
                  </td>
                  <td>{new Date(run.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
