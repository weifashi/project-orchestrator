import { useState } from "react";
import { useApi } from "../api/context";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { useLoad } from "./use-load";
export function MemoriesPage() {
  const api = useApi(),
    [project, setProject] = useState(""),
    { data, error } = useLoad(
      () => api.memories.list(project || undefined),
      [api, project],
    );
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Evidence with provenance</span>
          <h1 tabIndex={-1}>项目记忆</h1>
          <p className="muted">
            按项目读取决策、规则、事实、经验和交付证据；正文保存在 CAS。
          </p>
        </div>
        <label className="field">
          <span>项目 ID</span>
          <input
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="全部项目"
          />
        </label>
      </div>
      {error ? (
        <ErrorPanel error={error} />
      ) : !data?.length ? (
        <EmptyState />
      ) : (
        <div className="grid">
          {data.map((item) => (
            <article className="card span-6" key={item.id}>
              <div className="page-head">
                <div>
                  <strong>{item.title}</strong>
                  <small className="block">
                    {item.project_name ?? item.project_id}
                  </small>
                </div>
                <Badge>{item.memory_type}</Badge>
              </div>
              <p>{item.summary}</p>
              <small>
                来源 Run {item.source_run_id} · {item.retention_policy}
              </small>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
