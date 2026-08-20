import { Link } from "react-router-dom";
import { useApi } from "../api/context";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { VersionInspector } from "../components/version-inspector";
import { useLoad } from "./use-load";
const descriptions: Record<string, string> = {
  requirements: "澄清目标与验收边界",
  research: "调查现状与证据",
  architecture: "设计边界与数据流",
  "ui-design": "定义交互与视觉结构",
  implementation: "实现已批准的范围",
  "code-review": "审查正确性与可维护性",
  testing: "验证功能与回归",
  security: "检查权限、秘密与输入",
  operations: "交付、迁移与回滚",
  "memory-docs": "沉淀决策与交付证据",
};
export function RoleListPage() {
  const api = useApi(),
    { data, error } = useLoad(() => api.roles.list(), [api]);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Capability constrained</span>
          <h1 tabIndex={-1}>角色目录</h1>
          <p className="muted">
            10 个内置角色。申请能力最终与平台 allowlist 求交集，禁止项始终优先。
          </p>
        </div>
      </div>
      {error ? (
        <ErrorPanel error={error} />
      ) : !data?.length ? (
        <EmptyState />
      ) : (
        <div className="grid">
          {data.map((role) => (
            <article className="card role-card span-4" key={role.id}>
              <div className="page-head">
                <div>
                  <strong>{role.name}</strong>
                  <small className="block">
                    {role.slug} · v{role.version_number ?? "—"}
                  </small>
                </div>
                <Badge>{role.status}</Badge>
              </div>
              <p>{descriptions[role.slug] ?? "版本化角色协议"}</p>
              <div className="stage-pills">
                {role.effective_capabilities?.slice(0, 3).map((cap) => (
                  <span className="badge badge-live" key={cap}>
                    {cap}
                  </span>
                ))}
              </div>
              <details>
                <summary>历史版本</summary>
                <ul>
                  {role.versions?.map((version) => (
                    <li key={version.id}>
                      <details>
                        <summary>
                          v{version.version_number} · {version.status}
                        </summary>
                        <VersionInspector
                          load={() => api.roles.getDraft(role.id, version.id)}
                        />
                      </details>
                    </li>
                  ))}
                </ul>
              </details>
              <Link className="button" to={`/roles/${role.id}`}>
                编辑未来版本
              </Link>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
