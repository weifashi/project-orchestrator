import { Link } from "react-router-dom";
import { useApi } from "../api/context";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { VersionInspector } from "../components/version-inspector";
import { useI18n } from "../i18n";
import { useLoad } from "./use-load";
export function RoleListPage() {
  const api = useApi(), { t, label } = useI18n(), { data, error } = useLoad(() => api.roles.list(), [api]);
  return <div className="page"><div className="page-head"><div><span className="eyebrow">{t("capabilityConstrained")}</span><h1 tabIndex={-1}>{t("roles")}</h1><p className="muted">{t("roleDescription")}</p></div></div>
    {error ? <ErrorPanel error={error} /> : !data?.length ? <EmptyState /> : <div className="grid">{data.map((role) => <article className="card role-card span-4" key={role.id}><div className="page-head"><div><strong>{label(role.slug)}</strong><small className="block">{role.slug} · v{role.version_number ?? "—"}</small></div><Badge>{role.status}</Badge></div><p>{t("roleProtocol")}</p><div className="stage-pills">{role.effective_capabilities?.slice(0, 3).map((cap) => <span className="badge badge-live" key={cap}>{label(cap)}</span>)}</div><details><summary>{t("history")}</summary><ul>{role.versions?.map((version) => <li key={version.id}><details><summary>v{version.version_number} · {label(version.status)}</summary><VersionInspector load={() => api.roles.getDraft(role.id, version.id)} /></details></li>)}</ul></details><Link className="button" to={`/roles/${role.id}`}>{t("editFuture")}</Link></article>)}</div>}
  </div>;
}
