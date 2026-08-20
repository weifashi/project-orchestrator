import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

type NavItem = readonly [to: string, label: string, detail: string, path: string];
const nav: readonly NavItem[] = [
  ["/", "总览", "Dashboard", "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Zm3 1v4h4v-4H7Zm6 0v4h4v-4h-4Zm-6 6v3h4v-3H7Zm6 0v3h4v-3h-4Z"],
  ["/workflows", "流程模板", "Workflows", "M6 5h12v4H6V5Zm0 6h8v4H6v-4Zm0 6h12v2H6v-2Zm10-5 3 2.5-3 2.5v-5Z"],
  ["/roles", "角色目录", "Roles", "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0H5Zm13-11 3 2-3 2V9Z"],
  ["/runs", "Runs", "Observer", "M7 5v14l11-7L7 5Zm11 0h2v14h-2V5Z"],
  ["/memories", "项目记忆", "Memory", "M6 4h11a2 2 0 0 1 2 2v13l-4-2-4 2-4-2-4 2V7a3 3 0 0 1 3-3Zm0 3h9v2H6V7Zm0 4h7v2H6v-2Z"],
  ["/system", "系统诊断", "System", "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm0-5 1.5 3 3.3.5-2.4 2.3.6 3.2-3-1.5-3 1.5.6-3.2L7.2 6.5l3.3-.5L12 3Z"],
];
function Icon({ path }: { path: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="nav-icon">
      <path d={path} />
    </svg>
  );
}
export function AppShell() {
  const location = useLocation(),
    main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [location.pathname]);
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">跳到主内容</a>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="mark">PO</span>
          <span>
            <strong>Project Orchestrator</strong>
            <small>Local control plane</small>
          </span>
        </div>
        <div className="topbar-meta">
          <span>Template orchestration · read-only Runs</span>
          <span className="local-pill">
            <i />
            127.0.0.1 · Local only
          </span>
        </div>
      </header>
      <aside className="sidebar" aria-label="主导航">
        <div className="sidebar-note">
          <strong>Web 不执行任务，只观察与编排模板</strong>
          <span>开始、确认、重试都回到 Codex / Claude 会话。</span>
        </div>
        <nav>
          {nav.map(([to, label, detail, path]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <Icon path={path} />
              <span>
                {label}
                <small>{detail}</small>
              </span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <main ref={main} id="main-content">
        <Outlet />
      </main>
    </div>
  );
}
