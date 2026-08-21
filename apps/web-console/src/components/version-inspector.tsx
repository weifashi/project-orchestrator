import { useState } from "react";
import { useI18n } from "../i18n";
export function VersionInspector({ load }: { load: () => Promise<{ envelope: unknown }> }) {
  const { t } = useI18n(); const [envelope, setEnvelope] = useState<unknown>(), [error, setError] = useState("");
  if (envelope !== undefined) return <pre className="version-json">{JSON.stringify(envelope, null, 2)}</pre>;
  return <span><button className="button" type="button" onClick={() => { setError(""); void load().then((result) => setEnvelope(result.envelope), (reason: unknown) => setError(reason instanceof Error ? reason.message : t("loadFailed"))); }}>{t("viewPublished")}</button>{error ? <small role="alert">{error}</small> : null}</span>;
}
