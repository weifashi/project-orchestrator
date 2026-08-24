import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type { WorkflowDraft } from "../api/types";
import { useApi } from "../api/context";
import { CanvasDrawer } from "../components/canvas-drawer";
import { ErrorPanel } from "../components/error-panel";
import { WorkflowCanvas } from "../components/workflow-canvas";
import { createCanvasGroup } from "../components/workflow-graph";
import { useLoad } from "./use-load";
import { useI18n } from "../i18n";

const isTextInput = (target: EventTarget | null) => target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);

export function WorkflowEditorPage() {
  const { t, label } = useI18n();
  const { id = "" } = useParams(), api = useApi();
  const loaded = useLoad(() => api.workflows.getDraft(id), [api, id]);
  const roles = useLoad(() => api.roles.list(), [api]);
  const [draft, setDraft] = useState<WorkflowDraft>(), [selected, setSelected] = useState<string>(), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [past, setPast] = useState<WorkflowDraft["envelope"][]>([]), [future, setFuture] = useState<WorkflowDraft["envelope"][]>([]);
  useEffect(() => { setDraft(loaded.data); setPast([]); setFuture([]); setSelected(undefined); }, [loaded.data]);
  const stage = useMemo(() => draft?.envelope.data.stages.find((item) => item.key === selected), [draft, selected]);
  const applyEnvelope = useCallback((envelope: WorkflowDraft["envelope"]) => setDraft((current) => {
    if (!current || current.envelope === envelope) return current;
    setPast((items) => [...items.slice(-39), current.envelope]); setFuture([]);
    return { ...current, envelope };
  }), []);
  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true); setMessage("");
    try { const saved = await api.workflows.saveDraft(id, draft); setDraft(saved); setPast([]); setFuture([]); setMessage(`${t("savedMessage")} · ${t("revision")} ${saved.revision}`); }
    catch (error) { setMessage(error instanceof Error ? `${t("saveDraft")}：${error.message}` : t("operationFailed")); }
    finally { setBusy(false); }
  }, [api.workflows, draft, id, t]);
  const publish = async () => {
    if (!draft) return;
    setBusy(true); setMessage("");
    try { await api.workflows.publish(id, draft.envelope, `Published from Web revision ${draft.revision}`, draft.revision); const refreshed = await api.workflows.getDraft(id); setDraft(refreshed); setPast([]); setFuture([]); setMessage(t("publishedMessage")); }
    catch (error) { setMessage(error instanceof Error ? `${t("publish")}：${error.message}` : t("operationFailed")); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextInput(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) setFuture((items) => { const next = items.at(-1); if (!next) return items; setDraft((current) => current ? (setPast((history) => [...history, current.envelope]), { ...current, envelope: next }) : current); return items.slice(0, -1); });
        else setPast((items) => { const next = items.at(-1); if (!next) return items; setDraft((current) => current ? (setFuture((history) => [...history, current.envelope]), { ...current, envelope: next }) : current); return items.slice(0, -1); });
      }
      if (event.key === "Escape") setSelected(undefined);
    };
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);
  if (loaded.error) return <div className="page"><h1 tabIndex={-1}>{t("workflowEditor")}</h1><ErrorPanel error={loaded.error} /></div>;
  if (!draft) return <div className="page"><h1 tabIndex={-1}>{t("workflowEditor")}</h1><p role="status">{t("loading")}</p></div>;
  const patchStage = (patch: Partial<NonNullable<typeof stage>>) => stage && applyEnvelope({ ...draft.envelope, data: { ...draft.envelope.data, stages: draft.envelope.data.stages.map((item) => item.key === selected ? { ...item, ...patch } : item) } });
  const removeSelected = () => {
    if (!stage || stage.mandatory_gate) return;
    applyEnvelope({ ...draft.envelope, data: { ...draft.envelope.data, stages: draft.envelope.data.stages.filter((item) => item.key !== stage.key), edges: draft.envelope.data.edges.filter((edge) => edge.from !== stage.key && edge.to !== stage.key) } }); setSelected(undefined);
  };
  return <div className="page canvas-page">
    <header className="canvas-page-head"><div><span className="eyebrow">{t("workflowDraft")} · {t("revision")} {draft.revision}</span><h1 tabIndex={-1}>{label(draft.envelope.data.slug)}</h1></div><span className={`canvas-save-state ${past.length ? "is-dirty" : ""}`} role="status" aria-live="polite">{message || (past.length ? t("unsavedChanges") : t("onlyFutureRun"))}</span><div className="button-row"><button className="button ghost" type="button" disabled={!past.length} onClick={() => setPast((items) => { const next = items.at(-1); if (!next) return items; setDraft((current) => current ? (setFuture((history) => [...history, current.envelope]), { ...current, envelope: next }) : current); return items.slice(0, -1); })}>{t("undo")}</button><button className="button ghost" type="button" disabled={!future.length} onClick={() => setFuture((items) => { const next = items.at(-1); if (!next) return items; setDraft((current) => current ? (setPast((history) => [...history, current.envelope]), { ...current, envelope: next }) : current); return items.slice(0, -1); })}>{t("redo")}</button><button className="button" type="button" onClick={() => void api.workflows.getDraft(id, true).then((published) => { setDraft((current) => current ? { ...current, envelope: published.envelope } : published); setPast([]); setFuture([]); setMessage(t("draftLoaded")); }).catch(() => setMessage(t("operationFailed")))}>{t("copyTemplate")}</button><button className="button" type="button" disabled={busy} onClick={() => void save()}>{t("saveDraft")}</button><button className="button primary" type="button" disabled={busy} onClick={() => void publish()}>{t("publish")}</button></div></header>
    {roles.error ? <ErrorPanel error={roles.error as Error} /> : null}
    <section className="canvas-workspace"><WorkflowCanvas envelope={draft.envelope} roles={roles.data ?? []} label={label} onChange={applyEnvelope} onSelect={setSelected} /></section>
    {stage && <CanvasDrawer title={t("nodeSettings")} onClose={() => setSelected(undefined)} className="stage-inspector"><p className="muted">{label(stage.key)} · {stage.mandatory_gate ? t("mandatoryGate") : t("stageAndConstraints")}</p><div className="form-grid"><label className="field"><span>{t("failurePolicy")}</span><select value={stage.failure_policy} onChange={(event) => patchStage({ failure_policy: event.target.value as typeof stage.failure_policy })}><option value="pause">{t("pause")}</option><option value="fail">{t("fail")}</option><option value="retry_then_fail">{t("retry_then_fail")}</option><option value="trigger_iteration">{t("trigger_iteration")}</option></select></label><label className="field"><span>{t("maxAttempts")}</span><input type="number" min="1" value={stage.max_attempts} onChange={(event) => patchStage({ max_attempts: Math.max(1, Number(event.target.value) || 1) })} /></label><label className="check"><input type="checkbox" checked={stage.optional} onChange={(event) => patchStage({ optional: event.target.checked })} /> {t("optionalStage")}</label><label className="check"><input type="checkbox" checked={stage.requires_confirmation} onChange={(event) => patchStage({ requires_confirmation: event.target.checked })} /> {t("confirmationPoint")}</label></div><details><summary>{t("advancedSettings")}</summary><p className="muted">{t("roleVersion")}：{stage.role_version_id}<br/>{t("iterationGroup")}：{stage.iteration_group_key ?? "—"}</p></details>{stage.mandatory_gate ? <p className="notice">● {t("mandatoryGateLocked")}</p> : <div className="button-row"><button className="button" type="button" onClick={() => applyEnvelope(createCanvasGroup(draft.envelope, `group-${stage.key}`, label(stage.key), [stage.key]))}>{t("createGroup")}</button><button className="button danger" type="button" onClick={removeSelected}>{t("removeRole")}</button></div>}</CanvasDrawer>}
  </div>;
}
