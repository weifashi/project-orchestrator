import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../i18n";

type Props = { title: string; children: ReactNode; onClose: () => void; className?: string };

export function CanvasDrawer({ title, children, onClose, className = "" }: Props) {
  const { t } = useI18n();
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  const close = useCallback(() => {
    onClose();
    queueMicrotask(() => restoreFocus.current?.focus());
  }, [onClose]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);
  return <aside className={`canvas-drawer ${className}`} role="dialog" aria-modal="false" aria-label={title}>
    <header className="canvas-drawer-head"><h2>{title}</h2><button className="icon-button" type="button" aria-label={t("closePanel")} onClick={close}>×</button></header>
    <div className="canvas-drawer-body" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>{children}</div>
  </aside>;
}
