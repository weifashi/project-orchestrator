import { useI18n } from "../i18n";
export function ErrorPanel({ error }: { error: unknown }) {
  const { t } = useI18n();
  return <div className="error-panel" role="alert"><strong>{t("loadFailed")}</strong><span>{error instanceof Error ? error.message : t("unknown")}</span></div>;
}
