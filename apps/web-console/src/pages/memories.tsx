import { useState } from "react";
import { useApi } from "../api/context";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { useI18n } from "../i18n";
import { useLoad } from "./use-load";
export function MemoriesPage() { const api = useApi(), { t } = useI18n(), [project,setProject] = useState(""), {data,error}=useLoad(() => api.memories.list(project || undefined),[api,project]); return <div className="page"><div className="page-head"><div><span className="eyebrow">{t("provenance")}</span><h1 tabIndex={-1}>{t("memory")}</h1><p className="muted">{t("memoryDescription")}</p></div><label className="field"><span>{t("projectId")}</span><input value={project} onChange={(e)=>setProject(e.target.value)} placeholder={t("allProjects")}/></label></div>{error?<ErrorPanel error={error}/>:data===undefined?<p className="muted" role="status">{t("loading")}</p>:!data.length?<EmptyState/>:<div className="grid">{data.map((item)=><article className="card span-6" key={item.id}><div className="page-head"><div><strong>{item.title}</strong><small className="block">{item.project_name??item.project_id}</small></div><Badge>{item.memory_type}</Badge></div><p>{item.summary}</p><small>{t("sourceRun")} {item.source_run_id} · {item.retention_policy}</small></article>)}</div>}</div>; }
