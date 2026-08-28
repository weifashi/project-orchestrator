import { Link, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { MemoriesPage } from "./pages/memories";
import { OverviewPage } from "./pages/overview";
import { RoleEditorPage } from "./pages/role-editor";
import { RoleListPage } from "./pages/role-list";
import { RunDetailPage } from "./pages/run-detail";
import { RunListPage } from "./pages/run-list";
import { SystemPage } from "./pages/system";
import { WorkflowEditorPage } from "./pages/workflow-editor";
import { WorkflowListPage } from "./pages/workflow-list";
import { useI18n } from "./i18n";

function NotFoundPage() {
  const { t } = useI18n();
  return <div className="page"><div className="card not-found">
    <span className="eyebrow">404</span>
    <h1 tabIndex={-1}>{t("notFound")}</h1>
    <p className="muted">{t("notFoundDetail")}</p>
    <Link className="button primary" to="/">{t("backDashboard")}</Link>
  </div></div>;
}
export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="workflows" element={<WorkflowListPage />} />
        <Route path="workflows/:id" element={<WorkflowEditorPage />} />
        <Route path="roles" element={<RoleListPage />} />
        <Route path="roles/:id" element={<RoleEditorPage />} />
        <Route path="runs" element={<RunListPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="memories" element={<MemoriesPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
