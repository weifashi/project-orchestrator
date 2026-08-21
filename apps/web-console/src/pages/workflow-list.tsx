import { Link } from "react-router-dom";
import { useApi } from "../api/context";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { VersionInspector } from "../components/version-inspector";
import { useI18n } from "../i18n";
import { useLoad } from "./use-load";
export function WorkflowListPage() {
  const api = useApi(), { t, label, locale } = useI18n(), { data, error } = useLoad(() => api.workflows.list(), [api]);
  return <div className="page"><div className="page-head"><div><span className="eyebrow">{t("futureConfig")}</span><h1 tabIndex={-1}>{t("workflows")}</h1><p className="muted">{t("workflowDescription")}</p></div></div>
    {error ? <ErrorPanel error={error} /> : !data?.length ? <EmptyState /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>{t("template")}</th><th>{t("taskType")}</th><th>{t("version")}</th><th>{t("stagesCount")}</th><th>{t("status")}</th><th>{t("updatedAt")}</th></tr></thead><tbody>{data.map((item) => <tr key={item.id}><td><Link className="row-link" to={`/workflows/${item.id}`}>{label(item.slug)}</Link><br/><small>{item.slug}</small><details><summary>{t("viewPublished")}</summary><ul>{item.versions?.map((version) => <li key={version.id}><details><summary>v{version.version_number} · {version.description}</summary><VersionInspector load={() => api.workflows.getDraft(item.id, version.id)} /></details></li>)}</ul></details></td><td>{label(item.task_type)}</td><td>v{item.version_number ?? "—"}</td><td>{item.stage_count}</td><td><Badge>{item.status}</Badge></td><td>{new Date(item.updated_at).toLocaleString(locale)}</td></tr>)}</tbody></table></div>}
  </div>;
}
