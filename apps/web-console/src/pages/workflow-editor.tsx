import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { WorkflowDraft } from "../api/types";
import { useApi } from "../api/context";
import { ErrorPanel } from "../components/error-panel";
import { VersionBanner } from "../components/version-banner";
import { useLoad } from "./use-load";
export function WorkflowEditorPage() {
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
        <h1 tabIndex={-1}>流程编辑器</h1>
        <ErrorPanel error={loaded.error} />
      </div>
    );
  if (!draft)
    return (
      <div className="page">
        <h1 tabIndex={-1}>流程编辑器</h1>
        <p role="status">读取草稿…</p>
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
      setMessage(`草稿已保存 · revision ${saved.revision}`);
    } catch (error) {
      setMessage(
        error instanceof Error ? `保存失败：${error.message}` : "保存失败",
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
      setMessage("已发布不可变新版本；现有 Run 不受影响。");
    } catch (error) {
      setMessage(
        error instanceof Error ? `发布校验失败：${error.message}` : "发布失败",
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
            Workflow draft · revision {draft.revision}
          </span>
          <h1 tabIndex={-1}>{draft.envelope.data.slug}</h1>
          <p className="muted">
            用受约束的列表编辑 DAG，避免自由画布产生隐藏依赖。
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
                  setMessage("已把当前发布版本复制到草稿，尚未保存。");
                })
                .catch((error: unknown) =>
                  setMessage(
                    error instanceof Error
                      ? `复制失败：${error.message}`
                      : "复制失败",
                  ),
                );
            }}
          >
            复制模板
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() => void save()}
          >
            保存草稿
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void publish()}
          >
            发布新版本
          </button>
        </div>
      </div>
      <div className="grid">
        <section className="card span-8">
          <h2>阶段与约束</h2>
          <div className="stage-list">
            {stages.map((stage, index) => (
              <article className="stage" key={stage.key}>
                <div className="stage-head">
                  <div className="stage-title">
                    <strong>
                      {index + 1}. {stage.key}
                    </strong>
                    {stage.mandatory_gate && (
                      <span className="lock" aria-label="强制安全门，无法关闭">
                        ▣ mandatory gate
                      </span>
                    )}
                  </div>
                  <div className="button-row">
                    <button
                      className="button"
                      aria-label={`上移 ${stage.key}`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="button"
                      aria-label={`下移 ${stage.key}`}
                      disabled={index === stages.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </div>
                <div className="form-grid">
                  <label className="field">
                    <span>角色版本</span>
                    <input
                      value={stage.role_version_id}
                      onChange={(e) =>
                        updateStage(index, { role_version_id: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>失败策略</span>
                    <select
                      value={stage.failure_policy}
                      onChange={(e) =>
                        updateStage(index, {
                          failure_policy: e.target
                            .value as typeof stage.failure_policy,
                        })
                      }
                    >
                      <option value="pause">pause</option>
                      <option value="fail">fail</option>
                      <option value="retry_then_fail">retry_then_fail</option>
                      <option value="trigger_iteration">
                        trigger_iteration
                      </option>
                    </select>
                  </label>
                  <label className="field">
                    <span>最大尝试次数</span>
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
                    <span>迭代组</span>
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
                    可选阶段
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
                    Agent 会话确认点
                  </label>
                </div>
                <details>
                  <summary>
                    条件构建器（eq / ne / in / exists / all / any / not）
                  </summary>
                  <label className="field">
                    <span>受限条件 JSON</span>
                    <textarea
                      aria-label={`${stage.key} 条件`}
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
                              "条件已写入本地草稿，保存或发布后生效。",
                            );
                          } catch {
                            setMessage("条件不是有效 JSON");
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
            <h2>依赖边</h2>
            {draft.envelope.data.edges.map((edge, i) => (
              <div className="stage" key={`${edge.from}-${edge.to}-${i}`}>
                <label className="field">
                  <span>前置阶段</span>
                  <select
                    aria-label={`依赖 ${i + 1} 前置阶段`}
                    value={edge.from}
                    onChange={(event) =>
                      updateEdge(i, { from: event.target.value })
                    }
                  >
                    {stages.map((stage) => (
                      <option key={stage.key} value={stage.key}>
                        {stage.key}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>后继阶段</span>
                  <select
                    aria-label={`依赖 ${i + 1} 后继阶段`}
                    value={edge.to}
                    onChange={(event) =>
                      updateEdge(i, { to: event.target.value })
                    }
                  >
                    {stages.map((stage) => (
                      <option key={stage.key} value={stage.key}>
                        {stage.key}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>依赖类型</span>
                  <select
                    value={edge.edge_type}
                    onChange={(event) =>
                      updateEdge(i, {
                        edge_type: event.target.value as typeof edge.edge_type,
                      })
                    }
                  >
                    <option value="requires">requires</option>
                    <option value="on_success">on_success</option>
                  </select>
                </label>
                {edge.condition && <small>此依赖带受限条件。</small>}
              </div>
            ))}
          </section>
          <section className="card">
            <h2>并行 / 返工组</h2>
            {draft.envelope.data.iteration_groups.length ? (
              draft.envelope.data.iteration_groups.map((group, index) => (
                <div className="stage" key={group.key}>
                  <strong>{group.key}</strong>
                  <label className="field">
                    <span>返工入口阶段</span>
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
                          {stage.key}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>最大轮数（平台上限 3）</span>
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
