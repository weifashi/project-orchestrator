import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
const nav = [
  ["/", "总览", "◎"],
  ["/workflows", "流程模板", "◇"],
  ["/roles", "角色目录", "♙"],
  ["/runs", "Runs", "▷"],
  ["/memories", "项目记忆", "◫"],
  ["/system", "系统诊断", "⚙"],
] as const;
export function AppShell() {
  const location = useLocation(),
    main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [location.pathname]);
  return (
    <div className="app-frame">
      <header className="topbar">
        <div>
          <span className="mark">PO</span>
          <strong>Project Orchestrator</strong>
        </div>
        <span className="local-pill">
          <i />
          127.0.0.1 · Local only
        </span>
      </header>
      <aside className="sidebar" aria-label="主导航">
        {nav.map(([to, label, icon]) => (
          <NavLink key={to} to={to} end={to === "/"}>
            <span aria-hidden="true">{icon}</span>
            {label}
          </NavLink>
        ))}
      </aside>
      <main ref={main} id="main-content">
        <Outlet />
      </main>
    </div>
  );
}
