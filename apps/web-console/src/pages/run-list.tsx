import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/context";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { useI18n } from "../i18n";
import { useLoad } from "./use-load";
const filterFields = ["project_id", "origin_client_type", "status", "template", "date"] as const;
export function RunListPage() {
  const api = useApi(), { t, label, locale } = useI18n(), [filters, setFilters] = useState<Record<string, string>>({}), { data, error } = useLoad(() => api.runs.list(filters), [api, JSON.stringify(filters)]);
  const change = (key: string, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const fieldLabel = (key: typeof filterFields[number]) => ({ project_id: t("project"), origin_client_type: t("client"), status: t("status"), template: t("template"), date: t("date") })[key];
  const placeholder = (key: typeof filterFields[number]) => ({ project_id: t("filterProject"), origin_client_type: t("filterClient"), status: t("filterStatus"), template: t("filterTemplate"), date: t("date") })[key];
  return <div className="page"><div className="page-head"><div><span className="eyebrow">{t("readonlyEvidence")}</span><h1 tabIndex={-1}>{t("runs")}</h1><p className="muted">{t("activeStages")} {locale === "zh-CN" ? "由阶段状态推导，网页不能改写。" : "are derived from stage state and cannot be changed on Web."}</p></div><button className="button print-hidden" onClick={() => window.print()}>{t("exportReport")}</button></div><section className="card mb-16 print-hidden"><h2>{t("filter")}</h2><div className="filters">{filterFields.map((key) => <label className="field" key={key}><span>{fieldLabel(key)}</span>{key === "date" ? <input type="date" value={filters[key] ?? ""} onChange={(e) => change(key, e.target.value)} /> : <input value={filters[key] ?? ""} onChange={(e) => change(key, e.target.value)} placeholder={placeholder(key)} />}</label>)}</div></section>
    {error ? <ErrorPanel error={error} /> : data === undefined ? <p role="status">{t("loading")}</p> : !data.length ? <EmptyState title={t("noRuns")} detail={t("noRunsDetail")} /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>{t("objectiveProject")}</th><th>{t("source")}</th><th>{t("template")}</th><th>{t("activeStages")}</th><th>{t("status")}</th><th>{t("updatedAt")}</th></tr></thead><tbody>{data.map((run) => <tr key={run.id}><td><Link className="row-link" to={`/runs/${run.id}`}>{run.objective}</Link><br/><small>{run.project_name ?? run.project_id}</small></td><td>{run.origin_client_type}</td><td>{label(run.workflow_name ?? run.workflow_version_id)}</td><td><div className="stage-pills">{run.active_stages.length ? run.active_stages.map((stage) => <Badge key={stage}>{stage}</Badge>) : <span>—</span>}</div></td><td><Badge>{run.status}</Badge></td><td>{new Date(run.updated_at).toLocaleString(locale)}</td></tr>)}</tbody></table></div>}
  </div>;
}
