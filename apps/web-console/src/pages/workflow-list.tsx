import { useMemo, useState } from "react";
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
  const [query, setQuery] = useState("");
  const visible = useMemo(() => (data ?? []).filter((item) => `${label(item.slug)} ${item.slug} ${item.task_type}`.toLowerCase().includes(query.toLowerCase())), [data, label, query]);
  return <div className="page">
    <div className="page-head">
      <div>
        <span className="eyebrow">{t("futureConfig")}</span>
        <h1 tabIndex={-1}>{t("workflows")}</h1>
        <p className="muted">{t("workflowDescription")}</p>
      </div>
      <label className="field workflow-search">
        <span>{t("searchTemplates")}</span>
        <input type="search" aria-label={t("searchTemplates")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchTemplates")} />
      </label>
    </div>
    {error ? <ErrorPanel error={error} /> : data === undefined ? <p className="muted" role="status">{t("loading")}</p> : !visible.length ? <EmptyState /> : <div className="workflow-list">{visible.map((item) => <article className="workflow-list-item" key={item.id}>
      <span className="workflow-list-mark" aria-hidden>{label(item.slug).slice(0, 1)}</span>
      <div className="workflow-list-primary">
        <Link className="row-link" to={`/workflows/${item.id}`}>{label(item.slug)}</Link>
        <small>{item.slug}</small>
      </div>
      <div className="workflow-list-stats" aria-label={`${t("version")}、${t("stagesCount")}、${t("status")}`}>
        <span>v{item.version_number ?? "—"}</span>
        <span>{item.stage_count} {t("stagesCount")}</span>
        <Badge>{item.status}</Badge>
      </div>
      <time>{new Date(item.updated_at).toLocaleString(locale)}</time>
      <Link className="button workflow-list-edit" to={`/workflows/${item.id}`}>{t("editFuture")}</Link>
      <details className="workflow-list-history">
        <summary>{t("viewPublished")}</summary>
        <ul>{item.versions?.map((version) => <li key={version.id}><details><summary>v{version.version_number} · {version.description}</summary><VersionInspector load={() => api.workflows.getDraft(item.id, version.id)} /></details></li>)}</ul>
      </details>
    </article>)}</div>}
  </div>;
}
