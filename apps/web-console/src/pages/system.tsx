import { useApi } from "../api/context";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { useLoad } from "./use-load";
export function SystemPage() {
  const api = useApi(),
    { data, error } = useLoad(() => api.system.diagnostics(), [api]);
  if (error)
    return (
      <div className="page">
        <h1 tabIndex={-1}>系统诊断</h1>
        <ErrorPanel error={error} />
      </div>
    );
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Read only diagnostics</span>
          <h1 tabIndex={-1}>系统诊断</h1>
          <p className="muted">
            显示本机状态，不提供服务执行、凭证查看或任务控制。
          </p>
        </div>
        {data && <Badge>{data.status}</Badge>}
      </div>
      {!data ? (
        <p role="status">读取诊断…</p>
      ) : (
        <div className="grid">
          <section className="card span-7">
            <h2>服务与存储</h2>
            <div className="system-list">
              {[
                ["服务版本", data.version],
                ["Web listener", data.web_listener],
                ["Control socket", data.control_socket],
                ["SQLite 路径", data.database_path],
                [
                  "CAS 校验",
                  `${data.cas_status} · ${data.content_objects} objects`,
                ],
                ["最近备份", data.last_backup_at ?? "尚无备份记录"],
              ].map(([k, v]) => (
                <div className="system-row" key={k}>
                  <span className="muted">{k}</span>
                  <strong>{v}</strong>
                </div>
              ))}
            </div>
          </section>
          <aside className="card span-5">
            <h2>Adapter 能力清单</h2>
            {data.adapters.length ? (
              data.adapters.map((adapter) => (
                <div className="stage" key={adapter.id}>
                  <div className="stage-head">
                    <strong>{adapter.client_type}</strong>
                    <Badge>{adapter.status}</Badge>
                  </div>
                  <p className="muted">
                    v{adapter.adapter_version} · {adapter.id}
                  </p>
                  <small>
                    last seen {new Date(adapter.last_seen_at).toLocaleString()}
                  </small>
                  <pre className="json">
                    {JSON.stringify(adapter.capability_manifest ?? {}, null, 2)}
                  </pre>
                </div>
              ))
            ) : (
              <EmptyState title="没有 Adapter" />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
