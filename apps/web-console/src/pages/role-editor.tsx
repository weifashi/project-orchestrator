import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type { RoleDraft } from "../api/types";
import { useApi } from "../api/context";
import { ErrorPanel } from "../components/error-panel";
import { VersionBanner } from "../components/version-banner";
import { useLoad } from "./use-load";
const capabilities = [
  "read-workspace",
  "write-workspace",
  "network-read",
  "execute-tests",
  "managed-side-effect",
];
export function RoleEditorPage() {
  const { id = "" } = useParams(),
    api = useApi(),
    loaded = useLoad(() => api.roles.getDraft(id), [api, id]),
    catalog = useLoad(() => api.roles.list(), [api]);
  const [draft, setDraft] = useState<RoleDraft>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState<"active" | "disabled" | "archived">();
  useEffect(() => setDraft(loaded.data), [loaded.data]);
  useEffect(() => {
    const stored = catalog.data?.find((role) => role.id === id)?.status;
    if (stored) setStatus(stored);
  }, [catalog.data, id]);
  const requested = useMemo(
    () => new Set(draft?.envelope.data.requested_capabilities ?? []),
    [draft],
  );
  if (loaded.error)
    return (
      <div className="page">
        <h1 tabIndex={-1}>角色编辑器</h1>
        <ErrorPanel error={loaded.error} />
      </div>
    );
  if (!draft)
    return (
      <div className="page">
        <h1 tabIndex={-1}>角色编辑器</h1>
        <p role="status">读取草稿…</p>
      </div>
    );
  const data = draft.envelope.data,
    update = (patch: Partial<typeof data>) =>
      setDraft(
        (current) =>
          current && {
            ...current,
            envelope: {
              ...current.envelope,
              data: { ...current.envelope.data, ...patch },
            },
          },
      );
  const setCaps = (values: string[]) =>
    update({ requested_capabilities: values });
  const toggle = (cap: string) =>
    setCaps(
      requested.has(cap)
        ? data.requested_capabilities.filter((x) => x !== cap)
        : [...data.requested_capabilities, cap],
    );
  const act = async (kind: "save" | "publish") => {
    setBusy(true);
    setMessage("");
    try {
      if (kind === "save") {
        const saved = await api.roles.saveDraft(id, draft);
        setDraft(saved);
        setMessage(`草稿已保存 · revision ${saved.revision}`);
      } else {
        const result = (await api.roles.publish(
          id,
          draft.envelope,
          draft.revision,
          status,
        )) as {
          effectiveCapabilities?: string[];
        };
        setDraft(await api.roles.getDraft(id));
        catalog.setData((current) =>
          current?.map((role) =>
            role.id === id && status ? { ...role, status } : role,
          ),
        );
        setMessage(
          `已发布不可变新版本。有效能力：${result.effectiveCapabilities?.join("、") || "以服务端结果为准"}`,
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `${kind === "save" ? "保存" : "发布"}失败：${error.message}`
          : "操作失败",
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
            Role draft · revision {draft.revision}
          </span>
          <h1 tabIndex={-1}>{data.display_name}</h1>
          <p className="muted">
            请求能力 ∩ 平台允许能力 − 禁止能力 = 发布后的有效能力。
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
              void api.roles
                .getDraft(id, true)
                .then((published) => {
                  setDraft((current) =>
                    current
                      ? { ...current, envelope: published.envelope }
                      : published,
                  );
                  setMessage("已恢复当前内置发布版本；保存后才写入草稿。");
                })
                .catch((error: unknown) =>
                  setMessage(
                    error instanceof Error
                      ? `恢复失败：${error.message}`
                      : "恢复失败",
                  ),
                );
            }}
          >
            恢复内置
          </button>
          <button
            className="button"
            disabled={
              busy ||
              catalog.data?.find((role) => role.id === id)?.status ===
                "archived"
            }
            onClick={() => void act("save")}
          >
            保存草稿
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              status === undefined ||
              catalog.data?.find((role) => role.id === id)?.status ===
                "archived"
            }
            onClick={() => void act("publish")}
          >
            发布新版本
          </button>
        </div>
      </div>
      <div className="grid">
        <section className="card span-7">
          <h2>职责与契约</h2>
          <label className="field">
            <span>显示名称</span>
            <input
              value={data.display_name}
              onChange={(e) => update({ display_name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>职责（每行一项）</span>
            <textarea
              value={data.responsibilities.join("\n")}
              onChange={(e) =>
                update({
                  responsibilities: e.target.value.split("\n").filter(Boolean),
                })
              }
            />
          </label>
          <label className="field">
            <span>角色说明 Markdown</span>
            <textarea
              value={data.body_markdown}
              onChange={(e) => update({ body_markdown: e.target.value })}
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>输入 Schema</span>
              <textarea
                key={JSON.stringify(data.input_schema)}
                defaultValue={JSON.stringify(data.input_schema, null, 2)}
                onBlur={(e) => {
                  try {
                    update({
                      input_schema: JSON.parse(
                        e.target.value,
                      ) as typeof data.input_schema,
                    });
                  } catch {
                    setMessage("输入 Schema 不是有效 JSON");
                  }
                }}
              />
            </label>
            <label className="field">
              <span>输出 Schema</span>
              <textarea
                key={JSON.stringify(data.output_schema)}
                defaultValue={JSON.stringify(data.output_schema, null, 2)}
                onBlur={(e) => {
                  try {
                    update({
                      output_schema: JSON.parse(
                        e.target.value,
                      ) as typeof data.output_schema,
                    });
                  } catch {
                    setMessage("输出 Schema 不是有效 JSON");
                  }
                }}
              />
            </label>
          </div>
          <label className="field">
            <span>完成契约 / 必需产物</span>
            <textarea
              key={JSON.stringify(data.completion_contract)}
              defaultValue={JSON.stringify(data.completion_contract, null, 2)}
              onBlur={(e) => {
                try {
                  update({
                    completion_contract: JSON.parse(
                      e.target.value,
                    ) as typeof data.completion_contract,
                  });
                } catch {
                  setMessage("完成契约不是有效 JSON");
                }
              }}
            />
          </label>
        </section>
        <aside className="span-5">
          <section className="card">
            <h2>未来版本状态</h2>
            <label className="field">
              <span>角色状态</span>
              <select
                value={status ?? ""}
                disabled={
                  catalog.data?.find((role) => role.id === id)?.status ===
                  "archived"
                }
                onChange={(event) =>
                  setStatus(
                    event.target.value as
                      | "active"
                      | "disabled"
                      | "archived",
                  )
                }
              >
                <option value="" disabled>
                  读取当前状态…
                </option>
                <option value="active">active · 可用于未来 Run</option>
                <option value="disabled">disabled · 停止新引用</option>
                <option value="archived">archived · 永久归档</option>
              </select>
            </label>
            <p className="muted">历史 Run 和不可变版本仍保留。</p>
          </section>
          <section className="card">
            <h2>申请工具能力</h2>
            <div className="button-row">
              <button className="button" onClick={() => setCaps(capabilities)}>
                全选
              </button>
              <button
                className="button"
                onClick={() =>
                  setCaps(capabilities.filter((cap) => !requested.has(cap)))
                }
              >
                反选
              </button>
            </div>
            <div className="cap-grid mt-14">
              {capabilities.map((cap) => (
                <label className="check" key={cap}>
                  <input
                    type="checkbox"
                    checked={requested.has(cap)}
                    onChange={() => toggle(cap)}
                  />
                  {cap}
                </label>
              ))}
            </div>
          </section>
          <section className="card">
            <h2>平台禁止项</h2>
            <div className="notice danger">
              禁止能力优先，Web 无法授权平台禁用能力，也不能选择旧安全基线。
            </div>
            <ul>
              {data.forbidden_capabilities.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>发布时的交集</h2>
            <p className="json">requested ∩ platform allowlist − forbidden</p>
            <p className="muted">最终集合由服务端计算并随不可变版本保存。</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
