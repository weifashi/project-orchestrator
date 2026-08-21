import { useI18n } from "../i18n";
export function EmptyState({ title, detail }: { title?: string; detail?: string }) {
  const { t } = useI18n();
  return <div className="empty" role="status"><strong>{title ?? t("noData")}</strong><span>{detail ?? t("noDataDetail")}</span></div>;
}
