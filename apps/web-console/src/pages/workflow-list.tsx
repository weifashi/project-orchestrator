import { Link } from "react-router-dom";
import { useApi } from "../api/context";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { VersionInspector } from "../components/version-inspector";
import { useLoad } from "./use-load";
export function WorkflowListPage() {
  const api = useApi(),
    { data, error } = useLoad(() => api.workflows.list(), [api]);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Future configuration</span>
          <h1 tabIndex={-1}>流程模板</h1>
          <p className="muted">
            阶段、依赖、并行条件和安全门。发布只生成未来使用的新版本。
          </p>
        </div>
      </div>
      {error ? (
        <ErrorPanel error={error} />
      ) : !data?.length ? (
        <EmptyState />
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>模板</th>
                <th>任务类型</th>
                <th>版本</th>
                <th>阶段</th>
                <th>状态</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {data.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link className="row-link" to={`/workflows/${item.id}`}>
                      {item.name}
                    </Link>
                    <br />
                    <small>{item.slug}</small>
                    <details>
                      <summary>查看已发布版本</summary>
                      <ul>
                        {item.versions?.map((version) => (
                          <li key={version.id}>
                            <details>
                              <summary>
                                v{version.version_number} · {version.description}
                              </summary>
                              <VersionInspector
                                load={() =>
                                  api.workflows.getDraft(item.id, version.id)
                                }
                              />
                            </details>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </td>
                  <td>{item.task_type}</td>
                  <td>v{item.version_number ?? "—"}</td>
                  <td>{item.stage_count}</td>
                  <td>
                    <Badge>{item.status}</Badge>
                  </td>
                  <td>{new Date(item.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
