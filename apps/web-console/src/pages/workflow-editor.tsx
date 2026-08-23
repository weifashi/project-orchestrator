import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type { WorkflowDraft } from "../api/types";
import { useApi } from "../api/context";
import { ErrorPanel } from "../components/error-panel";
import { VersionBanner } from "../components/version-banner";
import { WorkflowCanvas } from "../components/workflow-canvas";
import { useLoad } from "./use-load";
import { useI18n } from "../i18n";

export function WorkflowEditorPage() {
  const { t, label } = useI18n();
  const { id = "" } = useParams(), api = useApi();
  const loaded = useLoad(() => api.workflows.getDraft(id), [api, id]);
  const roles = useLoad(() => api.roles.list(), [api]);
  const [draft, setDraft] = useState<WorkflowDraft>(), [selected, setSelected] = useState<string>(), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => setDraft(loaded.data), [loaded.data]);
  const stage = useMemo(() => draft?.envelope.data.stages.find((item) => item.key === selected), [draft, selected]);
  if (loaded.error) return <div className="page"><h1 tabIndex={-1}>{t("workflowEditor")}</h1><ErrorPanel error={loaded.error} /></div>;
  if (!draft) return <div className="page"><h1 tabIndex={-1}>{t("workflowEditor")}</h1><p role="status">{t("loading")}</p></div>;
  const patchStage = (patch: Partial<NonNullable<typeof stage>>) => setDraft((current) => current && ({ ...current, envelope: { ...current.envelope, data: { ...current.envelope.data, stages: current.envelope.data.stages.map((item) => item.key === selected ? { ...item, ...patch } : item) } } }));
  const removeSelected = () => {
    if (!stage || stage.mandatory_gate) return;
    setDraft((current) => {
      if (!current) return current;
      const data = current.envelope.data;
      const nextData = { ...data, stages: data.stages.filter((item) => item.key !== stage.key), edges: data.edges.filter((edge) => edge.from !== stage.key && edge.to !== stage.key) };
      if (data.canvas) nextData.canvas = { ...data.canvas, nodes: data.canvas.nodes.filter((node) => node.stage_key !== stage.key) };
      return { ...current, envelope: { ...current.envelope, data: nextData } };
    });
    setSelected(undefined);
  };
  const save = async () => { setBusy(true); setMessage(""); try { const saved = await api.workflows.saveDraft(id, draft); setDraft(saved); setMessage(`${t("savedMessage")} · ${t("revision")} ${saved.revision}`); } catch (error) { setMessage(error instanceof Error ? `${t("saveDraft")}：${error.message}` : t("operationFailed")); } finally { setBusy(false); } };
  const publish = async () => { setBusy(true); setMessage(""); try { await api.workflows.publish(id, draft.envelope, `Published from Web revision ${draft.revision}`, draft.revision); setDraft(await api.workflows.getDraft(id)); setMessage(t("publishedMessage")); } catch (error) { setMessage(error instanceof Error ? `${t("publish")}：${error.message}` : t("operationFailed")); } finally { setBusy(false); } };
  return <div className="page">
    <div className="page-head"><div><span className="eyebrow">{t("workflowDraft")} · {t("revision")} {draft.revision}</span><h1 tabIndex={-1}>{label(draft.envelope.data.slug)}</h1><p className="muted">拖动角色节点连线；从左侧角色库或节点上的「＋」快速添加角色。网页只保存未来流程，不能启动或控制正在执行的任务。</p></div></div>
    <VersionBanner />
    <div className="toolbar"><span role="status" aria-live="polite">{message}</span><div className="button-row"><button className="button" onClick={() => void api.workflows.getDraft(id, true).then((published) => { setDraft((current) => current ? { ...current, envelope: published.envelope } : published); setMessage(t("draftLoaded")); }).catch(() => setMessage(t("operationFailed")))}>{t("copyTemplate")}</button><button className="button" disabled={busy} onClick={() => void save()}>{t("saveDraft")}</button><button className="button primary" disabled={busy} onClick={() => void publish()}>{t("publish")}</button></div></div>
    {roles.error ? <ErrorPanel error={roles.error as Error} /> : null}
    <div className="grid"><section className="span-8"><WorkflowCanvas envelope={draft.envelope} roles={roles.data ?? []} label={label} onChange={(envelope) => setDraft((current) => current ? { ...current, envelope } : current)} onSelect={setSelected} /></section>
    <aside className="canvas-inspector span-4">{stage ? <><h2>{label(stage.key)}</h2><p className="muted">此处只显示常用设置；底层规则仍会在发布时再次校验。</p><div className="form-grid"><label className="field"><span>{t("failurePolicy")}</span><select value={stage.failure_policy} onChange={(event) => patchStage({ failure_policy: event.target.value as typeof stage.failure_policy })}><option value="pause">{t("pause")}</option><option value="fail">{t("fail")}</option><option value="retry_then_fail">{t("retry_then_fail")}</option><option value="trigger_iteration">{t("trigger_iteration")}</option></select></label><label className="field"><span>{t("maxAttempts")}</span><input type="number" min="1" value={stage.max_attempts} onChange={(event) => patchStage({ max_attempts: Math.max(1, Number(event.target.value) || 1) })} /></label><label className="check"><input type="checkbox" checked={stage.optional} onChange={(event) => patchStage({ optional: event.target.checked })} /> {t("optionalStage")}</label><label className="check"><input type="checkbox" checked={stage.requires_confirmation} onChange={(event) => patchStage({ requires_confirmation: event.target.checked })} /> {t("confirmationPoint")}</label></div>{stage.mandatory_gate ? <p className="notice">● {t("mandatoryGateLocked")}</p> : <button className="button danger" onClick={removeSelected}>移除这个角色</button>}</> : <><h2>选择一个角色</h2><p className="muted">点击画布节点后在这里调整它；从左侧「＋」快速添加角色。</p><p className="muted">安全门会以金色边框显示，不能移除或绕过。</p></>}</aside></div>
  </div>;
}
