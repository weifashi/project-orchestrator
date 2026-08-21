import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { WorkflowDraft } from "../api/types";
import { useApi } from "../api/context";
import { ErrorPanel } from "../components/error-panel";
import { VersionBanner } from "../components/version-banner";
import { useLoad } from "./use-load";
import { useI18n } from "../i18n";
export function WorkflowEditorPage() {
  const { t, label } = useI18n();
  const { id = "" } = useParams(),
    api = useApi(),
    loaded = useLoad(() => api.workflows.getDraft(id), [api, id]);
  const [draft, setDraft] = useState<WorkflowDraft>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => setDraft(loaded.data), [loaded.data]);
  if (loaded.error)
    return (
      <div className="page">
        <h1 tabIndex={-1}>{t("workflowEditor")}</h1>
        <ErrorPanel error={loaded.error} />
      </div>
    );
  if (!draft)
    return (
      <div className="page">
        <h1 tabIndex={-1}>{t("workflowEditor")}</h1>
        <p role="status">{t("loading")}</p>
      </div>
    );
  const stages = draft.envelope.data.stages;
  const updateStage = (
    index: number,
    patch: Partial<(typeof stages)[number]>,
  ) =>
    setDraft(
      (current) =>
        current && {
          ...current,
          envelope: {
            ...current.envelope,
            data: {
              ...current.envelope.data,
              stages: current.envelope.data.stages.map((s, i) =>
                i === index ? { ...s, ...patch } : s,
              ),
            },
          },
        },
    );
  const move = (index: number, by: number) =>
    setDraft((current) => {
      if (!current) return current;
      const next = [...current.envelope.data.stages],
        target = index + by;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return {
        ...current,
        envelope: {
          ...current.envelope,
          data: { ...current.envelope.data, stages: next },
        },
      };
    });
  const updateEdge = (
    index: number,
    patch: Partial<(typeof draft.envelope.data.edges)[number]>,
  ) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            envelope: {
              ...current.envelope,
              data: {
                ...current.envelope.data,
                edges: current.envelope.data.edges.map((edge, edgeIndex) =>
                  edgeIndex === index ? { ...edge, ...patch } : edge,
                ),
              },
            },
          }
        : current,
    );
  const updateGroup = (
    index: number,
    patch: Partial<(typeof draft.envelope.data.iteration_groups)[number]>,
  ) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            envelope: {
              ...current.envelope,
              data: {
                ...current.envelope.data,
                iteration_groups: current.envelope.data.iteration_groups.map(
                  (group, groupIndex) =>
                    groupIndex === index ? { ...group, ...patch } : group,
                ),
              },
            },
          }
        : current,
    );
  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      const saved = await api.workflows.saveDraft(id, draft);
      setDraft(saved);
      setMessage(`${t("savedMessage")} · ${t("revision")} ${saved.revision}`);
    } catch (error) {
      setMessage(
        error instanceof Error ? `${t("saveDraft")}：${error.message}` : t("operationFailed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    setBusy(true);
    setMessage("");
    try {
      await api.workflows.publish(
        id,
        draft.envelope,
        `Published from Web revision ${draft.revision}`,
        draft.revision,
      );
      setDraft(await api.workflows.getDraft(id));
      setMessage(t("publishedMessage"));
    } catch (error) {
      setMessage(
        error instanceof Error ? `${t("publish")}：${error.message}` : t("operationFailed"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">
            {t("workflowDraft")} · {t("revision")} {draft.revision}
          </span>
          <h1 tabIndex={-1}>{label(draft.envelope.data.slug)}</h1>
          <p className="muted">
            {t("safeListEditor")}
          </p>
        </div>
      </div>
      <VersionBanner />
      <div className="toolbar">
        <span role="status" aria-live="polite">
          {message}
        </span>
        <div className="button-row">
          <button
            className="button"
            onClick={() => {
              void api.workflows
                .getDraft(id, true)
                .then((published) => {
                  setDraft((current) =>
                    current
                      ? { ...current, envelope: published.envelope }
                      : published,
                  );
                  setMessage(t("draftLoaded"));
                })
                .catch((error: unknown) =>
                  setMessage(
                    error instanceof Error
                      ? `${t("copyTemplate")}：${error.message}`
                      : t("operationFailed"),
                  ),
                );
            }}
          >
            {t("copyTemplate")}
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() => void save()}
          >
            {t("saveDraft")}
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void publish()}
          >
            {t("publish")}
          </button>
        </div>
      </div>
      <div className="grid">
        <section className="card span-8">
          <h2>{t("stageAndConstraints")}</h2>
          <div className="stage-list">
            {stages.map((stage, index) => (
              <article className="stage" key={stage.key}>
                <div className="stage-head">
                  <div className="stage-title">
                    <strong>
                      {index + 1}. {label(stage.key)}
                    </strong>
                    {stage.mandatory_gate && (
                      <span className="lock" aria-label={t("mandatoryGateLocked")}>
                        ▣ {t("mandatoryGate")}
                      </span>
                    )}
                  </div>
                  <div className="button-row">
                    <button
                      className="button"
                      aria-label={`${t("moveUp")} ${label(stage.key)}`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="button"
                      aria-label={`${t("moveDown")} ${label(stage.key)}`}
                      disabled={index === stages.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </div>
                <div className="form-grid">
                  <label className="field">
                    <span>{t("roleVersionLabel")}</span>
                    <input
                      value={stage.role_version_id}
                      onChange={(e) =>
                        updateStage(index, { role_version_id: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("failurePolicy")}</span>
                    <select
                      value={stage.failure_policy}
                      onChange={(e) =>
                        updateStage(index, {
                          failure_policy: e.target
                            .value as typeof stage.failure_policy,
                        })
                      }
                    >
                      <option value="pause">{t("pause")}</option>
                      <option value="fail">{t("fail")}</option>
                      <option value="retry_then_fail">{t("retry_then_fail")}</option>
                      <option value="trigger_iteration">{t("trigger_iteration")}</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("maxAttempts")}</span>
                    <input
                      type="number"
                      min="1"
                      value={stage.max_attempts}
                      onChange={(e) =>
                        updateStage(index, {
                          max_attempts: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("iterationGroup")}</span>
                    <input
                      value={stage.iteration_group_key ?? ""}
                      onChange={(e) => {
                        const next = e.target.value;
                        if (next)
                          updateStage(index, { iteration_group_key: next });
                        else
                          setDraft((current) => {
                            if (!current) return current;
                            const stages = current.envelope.data.stages.map(
                              (item, i) => {
                                if (i !== index) return item;
                                const rest = { ...item };
                                delete rest.iteration_group_key;
                                return rest;
                              },
                            );
                            return {
                              ...current,
                              envelope: {
                                ...current.envelope,
                                data: { ...current.envelope.data, stages },
                              },
                            };
                          });
                      }}
                    />
                  </label>
                </div>
                <div className="button-row">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={stage.optional}
                      disabled={stage.mandatory_gate}
                      onChange={(e) =>
                        updateStage(index, { optional: e.target.checked })
                      }
                    />
                    {t("optionalStage")}
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={stage.requires_confirmation}
                      onChange={(e) =>
                        updateStage(index, {
                          requires_confirmation: e.target.checked,
                        })
                      }
                    />
                    {t("confirmationPoint")}
                  </label>
                </div>
                <details>
                  <summary>
                    {t("conditionBuilder")}（eq / ne / in / exists / all / any / not）
                  </summary>
                  <label className="field">
                    <span>{t("restrictedCondition")}</span>
                    <textarea
                      aria-label={`${label(stage.key)} ${t("restrictedCondition")}`}
                      defaultValue={
                        stage.condition
                          ? JSON.stringify(stage.condition, null, 2)
                          : ""
                      }
                      onBlur={(e) => {
                        const raw = e.currentTarget.value.trim();
                        if (raw) {
                          try {
                            updateStage(index, {
                              condition: JSON.parse(raw) as NonNullable<
                                typeof stage.condition
                              >,
                            });
                            setMessage(
                              t("conditionSaved"),
                            );
                          } catch {
                            setMessage(`${t("restrictedCondition")} ${t("invalidJson")}`);
                          }
                        } else
                          setDraft((current) => {
                            if (!current) return current;
                            const next = current.envelope.data.stages.map(
                              (item, i) => {
                                if (i !== index) return item;
                                const rest = { ...item };
                                delete rest.condition;
                                return rest;
                              },
                            );
                            return {
                              ...current,
                              envelope: {
                                ...current.envelope,
                                data: {
                                  ...current.envelope.data,
                                  stages: next,
                                },
                              },
                            };
                          });
                      }}
                    />
                  </label>
                </details>
              </article>
            ))}
          </div>
        </section>
        <aside className="span-4">
          <section className="card">
            <h2>{t("dependencyEdges")}</h2>
            {draft.envelope.data.edges.map((edge, i) => (
              <div className="stage" key={`${edge.from}-${edge.to}-${i}`}>
                <label className="field">
                  <span>{t("predecessor")}</span>
                  <select
                    aria-label={`${t("dependencyEdges")} ${i + 1} ${t("predecessor")}`}
                    value={edge.from}
                    onChange={(event) =>
                      updateEdge(i, { from: event.target.value })
                    }
                  >
                    {stages.map((stage) => (
                      <option key={stage.key} value={stage.key}>
                        {label(stage.key)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t("successor")}</span>
                  <select
                    aria-label={`${t("dependencyEdges")} ${i + 1} ${t("successor")}`}
                    value={edge.to}
                    onChange={(event) =>
                      updateEdge(i, { to: event.target.value })
                    }
                  >
                    {stages.map((stage) => (
                      <option key={stage.key} value={stage.key}>
                        {label(stage.key)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t("dependencyType")}</span>
                  <select
                    value={edge.edge_type}
                    onChange={(event) =>
                      updateEdge(i, {
                        edge_type: event.target.value as typeof edge.edge_type,
                      })
                    }
                  >
                    <option value="requires">{t("required")}</option>
                    <option value="on_success">{t("onSuccess")}</option>
                  </select>
                </label>
                {edge.condition && <small>{t("restrictedCondition")}</small>}
              </div>
            ))}
          </section>
          <section className="card">
            <h2>{t("iterationGroups")}</h2>
            {draft.envelope.data.iteration_groups.length ? (
              draft.envelope.data.iteration_groups.map((group, index) => (
                <div className="stage" key={group.key}>
                  <strong>{group.key}</strong>
                  <label className="field">
                    <span>{t("entryStage")}</span>
                    <select
                      value={group.entry_stage_key}
                      onChange={(event) =>
                        updateGroup(index, {
                          entry_stage_key: event.target.value,
                        })
                      }
                    >
                      {stages.map((stage) => (
                        <option key={stage.key} value={stage.key}>
                          {label(stage.key)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("maxIterations")}</span>
                    <input
                      type="number"
                      min="1"
                      max="3"
                      value={group.max_iterations}
                      onChange={(event) =>
                        updateGroup(index, {
                          max_iterations: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <div className="button-row">
                    <button
                      className="button"
                      onClick={() =>
                        updateGroup(index, {
                          gate_stage_keys: stages.map((stage) => stage.key),
                        })
                      }
                    >
                      全选安全门
                    </button>
                    <button
                      className="button"
                      onClick={() =>
                        updateGroup(index, {
                          gate_stage_keys: stages
                            .map((stage) => stage.key)
                            .filter(
                              (key) => !group.gate_stage_keys.includes(key),
                            ),
                        })
                      }
                    >
                      反选安全门
                    </button>
                  </div>
                  {stages.map((stage) => (
                    <label className="check" key={stage.key}>
                      <input
                        type="checkbox"
                        checked={group.gate_stage_keys.includes(stage.key)}
                        onChange={() =>
                          updateGroup(index, {
                            gate_stage_keys: group.gate_stage_keys.includes(
                              stage.key,
                            )
                              ? group.gate_stage_keys.filter(
                                  (key) => key !== stage.key,
                                )
                              : [...group.gate_stage_keys, stage.key],
                          })
                        }
                      />
                      {stage.key}
                    </label>
                  ))}
                </div>
              ))
            ) : (
              <p className="muted">
                本模板没有迭代组；无依赖冲突的 ready 阶段可并行。
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
