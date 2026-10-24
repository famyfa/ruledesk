import { useEffect, useState, type ReactNode } from "react";
import { canRedo, canUndo, redo, undo } from "@ruledeck/core";
import { useWorkspace } from "../workspace.tsx";
import { ChangesPanel } from "./ChangesPanel.tsx";

export type Page = "overview" | "firewalls" | "rules" | "aliases" | "changes" | "audit" | "settings";

const NAV: { page: Page; label: string; icon: string }[] = [
  { page: "overview", label: "Overview", icon: "◫" },
  { page: "firewalls", label: "Firewalls", icon: "⛨" },
  { page: "rules", label: "Firewall Rules", icon: "☰" },
  { page: "aliases", label: "Aliases", icon: "⌘" },
  { page: "changes", label: "Pending Changes", icon: "Δ" },
  { page: "audit", label: "Audit Log", icon: "⏱" },
  { page: "settings", label: "Settings", icon: "⚙" },
];

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export function Shell({
  page,
  setPage,
  user,
  onLogout,
  onShowRule,
  theme,
  setTheme,
  children,
}: {
  page: Page;
  setPage: (p: Page) => void;
  user: string;
  onLogout: () => void;
  onShowRule: (id: string) => void;
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
  children: ReactNode;
}) {
  const ws = useWorkspace();
  const { wc, changeSet, validation, connection, loading, externalChanges, restoredFrom, notices, dismiss, edit, reload, checkForExternalChanges } = ws;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const pending = changeSet?.changes.length ?? 0;
  const problems = validation?.errorCount ?? 0;

  // Global undo/redo when not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        edit(undo);
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        edit(redo);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [edit]);

  // Warn before closing the tab with unsaved work (it's also kept in localStorage).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [pending]);

  const conn =
    connection.status === "connected"
      ? { cls: "ok", text: `Connected · OPNsense ${connection.info.productVersion}` }
      : connection.status === "error"
        ? { cls: "err", text: `Connection failed: ${connection.error.message}` }
        : { cls: "unknown", text: loading ? "Connecting…" : "Not connected" };

  const fw = ws.firewalls.find((f) => f.id === ws.firewallId);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ▦
          </span>
          RuleDeck
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.page}>
              <button type="button" className={page === n.page ? "active" : ""} aria-current={page === n.page ? "page" : undefined} onClick={() => setPage(n.page)}>
                <span className="nav-icon" aria-hidden>
                  {n.icon}
                </span>
                <span className="nav-label">{n.label}</span>
                {n.page === "changes" && pending > 0 && <span className="badge">{pending}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          <button type="button" className="ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle theme">
            {theme === "dark" ? "☀ Light" : "☾ Dark"}
          </button>
          <div className="user">
            {user}{" "}
            <button type="button" className="link-button" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </div>
      </nav>

      <div className="main-col">
        <header className="toolbar">
          <div className="fw-select">
            <span className="fw-name">{fw?.name ?? "No firewall"}</span>
            <span className="muted">{fw?.host}</span>
          </div>
          <span className={`conn conn-${conn.cls}`} role="status">
            <span className="dot" aria-hidden /> {conn.text}
          </span>
          <span className="spacer" />
          <button type="button" className="ghost" disabled={!wc || !canUndo(wc)} onClick={() => edit(undo)} title="Undo (Ctrl+Z)">
            ↶ Undo
          </button>
          <button type="button" className="ghost" disabled={!wc || !canRedo(wc)} onClick={() => edit(redo)} title="Redo (Ctrl+Y)">
            ↷ Redo
          </button>
          {confirmRefresh ? (
            <span className="confirm-inline">
              Reloading discards {pending} staged change{pending === 1 ? "" : "s"}.
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setConfirmRefresh(false);
                  void reload({ discardLocal: true });
                }}
              >
                Discard &amp; reload
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmRefresh(false);
                  void checkForExternalChanges();
                }}
              >
                Only check for changes
              </button>
              <button type="button" className="ghost" onClick={() => setConfirmRefresh(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="ghost" onClick={() => (pending ? setConfirmRefresh(true) : void reload())} title="Reload from the firewall">
              ⟳ Refresh
            </button>
          )}
          <button
            type="button"
            className={`pending-button${pending ? " has-pending" : ""}`}
            onClick={() => setDrawerOpen((o) => !o)}
            aria-expanded={drawerOpen}
            aria-controls="changes-drawer"
          >
            {pending} pending{problems > 0 && <span className="text-error"> · {problems} ⚠</span>}
          </button>
          <button type="button" className="primary" disabled={!pending || problems > 0} onClick={() => setPage("changes")} title={problems ? "Fix problems first" : "Review the changes before applying"}>
            Review &amp; apply
          </button>
        </header>

        {restoredFrom && pending > 0 && (
          <div className="banner banner-info" role="status">
            Restored {pending} staged change{pending === 1 ? "" : "s"} from {new Date(restoredFrom).toLocaleString()}. They are still only local.
          </div>
        )}
        {externalChanges.length > 0 && (
          <div className="banner banner-warn" role="alert">
            ⚠ {externalChanges.length} rule/alias object{externalChanges.length === 1 ? "" : "s"} changed on the firewall since you loaded it (someone else may be editing).
            Conflicts are checked again before anything is applied.{" "}
            {pending === 0 && (
              <button type="button" className="link-button" onClick={() => void reload({ discardLocal: true })}>
                Reload now
              </button>
            )}
          </div>
        )}

        <main id="main" className="content">
          {ws.loadError && !wc ? (
            <div className="banner banner-error" role="alert">
              {ws.loadError}{" "}
              <button type="button" onClick={() => void reload()}>
                Retry
              </button>
            </div>
          ) : !wc ? (
            <p className="muted pad">{loading ? "Loading firewall configuration…" : "No firewall configured."}</p>
          ) : (
            children
          )}
        </main>

        {drawerOpen && wc && (
          <section id="changes-drawer" className="drawer" aria-label="Pending changes">
            <ChangesPanel
              onShowRule={(id) => {
                onShowRule(id);
              }}
              onReview={() => {
                setDrawerOpen(false);
                setPage("changes");
              }}
            />
          </section>
        )}
      </div>

      <div className="notices" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={`notice notice-${n.tone}`} role={n.tone === "error" ? "alert" : "status"}>
            <span>{n.text}</span>
            <button type="button" className="ghost" aria-label="Dismiss" onClick={() => dismiss(n.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
