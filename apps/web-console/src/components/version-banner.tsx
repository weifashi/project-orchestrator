import { useI18n } from "../i18n";
export function VersionBanner() { const { t } = useI18n(); return <aside className="version-banner"><strong>{t("onlyFutureRun")}</strong><span>{t("onlyFutureRunBody")}</span></aside>; }
