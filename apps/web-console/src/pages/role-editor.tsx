import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type { RoleDraft } from "../api/types";
import { useApi } from "../api/context";
import { ErrorPanel } from "../components/error-panel";
import { VersionBanner } from "../components/version-banner";
import { useLoad } from "./use-load";
import { useI18n } from "../i18n";
import { CAPABILITIES } from "../capabilities";
const capabilities: string[] = [...CAPABILITIES];
export function RoleEditorPage() {
  const { t, label, named } = useI18n();
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
        <h1 tabIndex={-1}>{t("roles")}</h1>
        <ErrorPanel error={loaded.error} />
      </div>
    );
  if (!draft)
    return (
      <div className="page">
        <h1 tabIndex={-1}>{t("roles")}</h1>
        <p role="status">{t("loading")}</p>
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
        setMessage(`${t("savedMessage")} · ${t("revision")} ${saved.revision}`);
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
          `${t("publishedMessage")} ${t("requestCapabilities")}：${result.effectiveCapabilities?.map(label).join("、") || t("unknown")}`,
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `${kind === "save" ? t("saveDraft") : t("publish")}：${error.message}`
          : t("operationFailed"),
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
            {t("roleDraft")} · {t("revision")} {draft.revision}
          </span>
          <h1 tabIndex={-1}>{named(data.slug, data.display_name)}</h1>
          <p className="muted">
            {t("publishIntersection")}
          </p>
        </div>
      </div>
      <VersionBanner />
      {catalog.error ? <ErrorPanel error={catalog.error} /> : null}
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
                  setMessage(t("restoreMessage"));
                })
                .catch((error: unknown) =>
                  setMessage(
                    error instanceof Error
                      ? `${t("copyPublished")}：${error.message}`
                      : t("operationFailed"),
                  ),
                );
            }}
          >
            {t("copyPublished")}
          </button>
          {catalog.data?.find((role) => role.id === id)?.is_builtin === true && (
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api.roles
                  .resetBuiltin(id)
                  .then(async () => {
                    const [nextDraft, nextCatalog] = await Promise.all([
                      api.roles.getDraft(id),
                      api.roles.list(),
                    ]);
                    loaded.setData(nextDraft);
                    setDraft(nextDraft);
                    catalog.setData(nextCatalog);
                    setStatus(nextCatalog.find((role) => role.id === id)?.status);
                    setMessage(t("roleResetBuiltin"));
                  })
                  .catch((error: unknown) =>
                    setMessage(
                      error instanceof Error
                        ? `${t("resetBuiltin")}：${error.message}`
                        : t("operationFailed"),
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {t("resetBuiltin")}
            </button>
          )}
          <button
            className="button"
            disabled={
              busy ||
              catalog.data?.find((role) => role.id === id)?.status ===
                "archived"
            }
            onClick={() => void act("save")}
          >
            {t("saveDraft")}
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
            {t("publish")}
          </button>
        </div>
      </div>
      <div className="grid">
        <section className="card span-7">
          <h2>{t("roleContract")}</h2>
          <label className="field">
            <span>{t("displayName")}</span>
            <input
              value={data.display_name}
              onChange={(e) => update({ display_name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t("responsibilities")}</span>
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
            <span>{t("roleMarkdown")}</span>
            <textarea
              value={data.body_markdown}
              onChange={(e) => update({ body_markdown: e.target.value })}
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>{t("inputSchema")}</span>
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
                    setMessage(`${t("inputSchema")} ${t("invalidJson")}`);
                  }
                }}
              />
            </label>
            <label className="field">
              <span>{t("outputSchema")}</span>
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
                    setMessage(`${t("outputSchema")} ${t("invalidJson")}`);
                  }
                }}
              />
            </label>
          </div>
          <label className="field">
            <span>{t("completionContract")}</span>
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
                  setMessage(`${t("completionContract")} ${t("invalidJson")}`);
                }
              }}
            />
          </label>
        </section>
        <aside className="span-5">
          <section className="card">
            <h2>{t("futureStatus")}</h2>
            <label className="field">
              <span>{t("roleStatus")}</span>
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
                  {t("loading")}
                </option>
                <option value="active">{t("active")} · {t("availableFuture")}</option>
                <option value="disabled">{t("disabled")} · {t("stopNewReferences")}</option>
                <option value="archived">{t("archived")} · {t("permanentlyArchived")}</option>
              </select>
            </label>
            <p className="muted">{t("historyPreserved")}</p>
          </section>
          <section className="card">
            <h2>{t("requestCapabilities")}</h2>
            <div className="button-row">
              <button className="button" onClick={() => setCaps(capabilities)}>
                {t("selectAll")}
              </button>
              <button
                className="button"
                onClick={() =>
                  setCaps(capabilities.filter((cap) => !requested.has(cap)))
                }
              >
                {t("invertSelection")}
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
                  {label(cap)}
                </label>
              ))}
            </div>
          </section>
          <section className="card">
            <h2>{t("platformDenied")}</h2>
            <div className="notice danger">
              {t("cannotGrant")}
            </div>
            <ul>
              {data.forbidden_capabilities.map((item) => (
                <li key={item}>{label(item)}</li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>{t("publishIntersection")}</h2>
            <p className="json">{t("publishIntersection")}</p>
            <p className="muted">{t("userContentNotice")}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
