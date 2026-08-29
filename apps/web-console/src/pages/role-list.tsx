import { useState } from "react";
import { Link } from "react-router-dom";
import type { RoleSummary } from "../api/types";
import { useApi } from "../api/context";
import { CAPABILITIES } from "../capabilities";
import { Badge } from "../components/badge";
import { CanvasDrawer } from "../components/canvas-drawer";
import { EmptyState } from "../components/empty-state";
import { ErrorPanel } from "../components/error-panel";
import { useI18n } from "../i18n";
import { useLoad } from "./use-load";

function CreateRoleForm({ busy, onCancel, onSubmit }: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { slug: string; display_name: string; responsibilities: string[]; requested_capabilities: string[] }) => void;
}) {
  const { t, label } = useI18n();
  const [slug, setSlug] = useState(""), [name, setName] = useState(""),
    [duties, setDuties] = useState(""), [caps, setCaps] = useState<string[]>(["read-workspace"]);
  const requested = new Set(caps);
  const lines = duties.split("\n").map((line) => line.trim()).filter(Boolean);
  const ready = /^[a-z][a-z0-9-]*$/.test(slug) && name.trim() !== "" && lines.length > 0;
  return <CanvasDrawer title={t("newRoleTitle")} onClose={onCancel} className="role-create">
    <p className="muted">{t("newRoleHint")}</p>
    <div className="field">
      <label htmlFor="role-slug"><span>{t("roleSlug")}</span></label>
      <input id="role-slug" autoFocus value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="my-role" aria-describedby="role-slug-hint" />
      <small id="role-slug-hint" className="muted">{t("roleSlugHint")}</small>
    </div>
    <label className="field"><span>{t("displayName")}</span>
      <input value={name} onChange={(event) => setName(event.target.value)} />
    </label>
    <label className="field"><span>{t("roleResponsibilities")}</span>
      <textarea rows={3} value={duties} onChange={(event) => setDuties(event.target.value)} />
    </label>
    <h3>{t("requestCapabilities")}</h3>
    <div className="button-row">
      <button className="button" type="button" onClick={() => setCaps([...CAPABILITIES])}>{t("selectAll")}</button>
      <button className="button" type="button" onClick={() => setCaps(CAPABILITIES.filter((cap) => !requested.has(cap)))}>{t("invertSelection")}</button>
    </div>
    <div className="cap-grid mt-14">{CAPABILITIES.map((cap) => <label className="check" key={cap}>
      <input type="checkbox" checked={requested.has(cap)}
        onChange={() => setCaps((current) => current.includes(cap) ? current.filter((item) => item !== cap) : [...current, cap])} />
      {label(cap)}
    </label>)}</div>
    <div className="button-row drawer-actions">
      <button className="button primary" type="button" disabled={busy || !ready}
        onClick={() => onSubmit({ slug, display_name: name.trim(), responsibilities: lines, requested_capabilities: caps })}>
        {t("create")}
      </button>
      <button className="button ghost" type="button" disabled={busy} onClick={onCancel}>{t("cancel")}</button>
    </div>
  </CanvasDrawer>;
}

export function RoleListPage() {
  const api = useApi(), { t, label, named } = useI18n();
  const [reload, setReload] = useState(0), [creating, setCreating] = useState(false),
    [showRemoved, setShowRemoved] = useState(false), [confirming, setConfirming] = useState(""),
    [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  // 一次取全量（含已移除），前端拆成"在用"与"已移除"两组，省一次往返。
  const { data, error } = useLoad(() => api.roles.list(true), [api, reload]);

  const act = (action: Promise<unknown>, done: string): void => {
    setBusy(true);
    void action
      .then(() => { setMessage(done); setCreating(false); setConfirming(""); setReload((count) => count + 1); },
        (reason: unknown) => setMessage(reason instanceof Error ? reason.message : t("operationFailed")))
      .finally(() => setBusy(false));
  };

  const card = (role: RoleSummary) => <article className="card role-card span-4" key={role.id}>
    <div className="page-head">
      <div><strong>{named(role.slug, role.name)}</strong><small className="block">{role.slug}</small></div>
      <Badge>{role.is_builtin ? t("builtin") : t("custom")}</Badge>
    </div>
    <div className="stage-pills">{role.effective_capabilities?.slice(0, 3).map((cap) => <span className="badge badge-live" key={cap}>{label(cap)}</span>)}</div>
    {confirming === role.id
      ? <div className="notice danger">
          <strong className="block">{t("removeRoleTitle")}</strong>
          <p>{t("removeRoleBody")}</p>
          <p>{t("removeRoleKeepsHistory")}</p>
          <p>{t("removeRoleNotRevoke")}</p>
          <div className="button-row">
            <button className="button danger" type="button" disabled={busy}
              onClick={() => act(api.roles.remove(role.id), t("roleRemoved"))}>{t("remove")}</button>
            <button className="button ghost" type="button" disabled={busy} onClick={() => setConfirming("")}>{t("cancel")}</button>
          </div>
        </div>
      : <div className="button-row">
          <Link className="button" to={`/roles/${role.id}`}>{t("editRole")}</Link>
          <button className="button danger" type="button" disabled={busy} onClick={() => setConfirming(role.id)}>{t("remove")}</button>
        </div>}
  </article>;

  const present = data?.filter((role) => !role.removed_at) ?? [];
  const removed = data?.filter((role) => role.removed_at) ?? [];

  return <div className="page">
    <div className="page-head">
      <div><span className="eyebrow">{t("capabilityConstrained")}</span><h1 tabIndex={-1}>{t("roles")}</h1><p className="muted">{t("roleDescription")}</p></div>
      <div className="button-row">
        <button className="button ghost removed-roles-toggle" type="button" aria-expanded={showRemoved}
          aria-controls="removed-roles-panel" onClick={() => setShowRemoved((visible) => !visible)}>
          <span aria-hidden="true">{showRemoved ? "▾" : "▸"}</span> {t("removedRoles")} ({removed.length})
        </button>
        <button className="button primary" type="button" disabled={busy || creating} onClick={() => { setCreating(true); setMessage(""); }}>{t("newRole")}</button>
      </div>
    </div>
    <p role="status" aria-live="polite" className="muted">{message}</p>
    {creating && <CreateRoleForm busy={busy} onCancel={() => setCreating(false)}
      onSubmit={(input) => act(api.roles.create(input), t("roleCreated"))} />}
    {error ? <ErrorPanel error={error} /> : data === undefined ? <p className="muted" role="status">{t("loading")}</p> : <div className="grid">
      {present.length ? present.map(card) : <EmptyState />}
      {showRemoved && <section id="removed-roles-panel" className="card span-12" role="region" aria-label={t("removedRoles")}>
          {removed.length === 0 ? <p className="muted">{t("noRemovedRoles")}</p> : <ul>{removed.map((role) => <li key={role.id}>
            <div className="page-head">
              <div><strong>{named(role.slug, role.name)}</strong><small className="block">{role.slug} · {role.is_builtin ? t("builtin") : t("custom")}</small></div>
              <div className="button-row">
                <button className="button" type="button" disabled={busy}
                  onClick={() => act(api.roles.restore(role.id), t("roleRestored"))}>{t("restore")}</button>
                {role.is_builtin && <button className="button" type="button" disabled={busy}
                  onClick={() => act(api.roles.resetBuiltin(role.id), t("roleResetBuiltin"))}>{t("resetBuiltin")}</button>}
              </div>
            </div>
          </li>)}</ul>}
      </section>}
    </div>}
  </div>;
}
