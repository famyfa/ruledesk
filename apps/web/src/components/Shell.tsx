import { useEffect, useState, type ReactNode } from "react";
import { canRedo, canUndo, redo, SERVICES, undo } from "@ruledeck/core";
import { useWorkspace } from "../workspace.tsx";
import type { ApiErrorBody } from "../api.ts";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { SiteSignInDialog } from "./SignIn.tsx";
import { HaBanner } from "./HaSwitch.tsx";

export type Page = `service:${string}` | "certificates" | "shared-rules" | "shared-aliases" | "shared-apply" | "shared-drift" | "overview" | "global-rules" | "global-aliases" | "monitor" | "sites" | "rules" | "aliases" | "changes" | "history" | "settings";

/**
 * Panorama-style navigation: tabs along the top; tabs with sub-pages also show a
 * tree on the left. Tabs without a tree open their single page directly.
 */
interface NavTab {
  id: string;
  label: string;
  pages: { page: Page; label: string; group?: string }[];
  /** Show the left tree for this tab. */
  tree?: boolean;
}

const TABS: NavTab[] = [
  { id: "dashboard", label: "Dashboard", pages: [{ page: "overview", label: "Overview" }] },
  { id: "monitor", label: "Monitor", tree: true, pages: [{ page: "monitor", label: "Firewall Log" }] },
  { id: "policies", label: "Policies", tree: true, pages: [{ page: "rules", label: "Firewall Rules" }] },
  { id: "objects", label: "Objects", tree: true, pages: [{ page: "aliases", label: "Aliases" }] },
  {
    id: "global",
    label: "Global",
    tree: true,
    pages: [
      { page: "shared-rules", label: "Shared rules", group: "Shared policy (all sites)" },
      { page: "shared-aliases", label: "Shared aliases", group: "Shared policy (all sites)" },
      { page: "shared-apply", label: "Apply to all sites", group: "Shared policy (all sites)" },
      { page: "shared-drift", label: "Drift", group: "Shared policy (all sites)" },
      { page: "global-rules", label: "Rules, all sites", group: "Compare sites" },
      { page: "global-aliases", label: "Aliases, all sites", group: "Compare sites" },
    ],
  },
  {
    id: "services",
    label: "Services",
    tree: true,
    pages: [
      ...(["DHCP & DNS", "Network", "Firewall", "System", "Security"] as const).flatMap((group) => SERVICES.filter((s) => s.group === group).map((s) => ({ page: `service:${s.id}` as Page, label: s.label, group }))),
      { page: "certificates", label: "Certificates", group: "Security" as const },
    ],
  },
  { id: "sites", label: "Sites", pages: [{ page: "sites", label: "Sites" }] },
  { id: "changes", label: "Changes", pages: [{ page: "changes", label: "Pending Changes" }] },
  { id: "history", label: "History", pages: [{ page: "history", label: "History" }] },
  { id: "settings", label: "Settings", pages: [{ page: "settings", label: "Settings" }] },
];

/** Pages that show the loaded rules; the others work without a loaded site. */
const NEEDS_WORKING_COPY = new Set<Page>(["overview", "rules", "aliases", "changes", "shared-rules", "shared-aliases"]);

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export function Shell({
  page,
  setPage,
  onLogout,
  onShowRule,
  theme,
  setTheme,
  signInErrors,
  children,
}: {
  page: Page;
  setPage: (p: Page) => void;
  onLogout: () => void;
  signInErrors: Record<string, ApiErrorBody>;
  onShowRule: (id: string) => void;
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
  children: ReactNode;
}) {
  const ws = useWorkspace();
  const { wc, changeSet, validation, site, sites, loading, externalChanges, restoredFrom, notices, dismiss, edit, reload, checkForExternalChanges } = ws;
  const [hideSignInErrors, setHideSignInErrors] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const pending = changeSet?.changes.length ?? 0;
  const problems = validation?.errorCount ?? 0;
  const activeTab = TABS.find((t) => t.pages.some((p) => p.page === page)) ?? TABS[0]!;
  const counts: Partial<Record<Page, number>> = ws.shared
    ? { "shared-rules": wc?.current.rules.length, "shared-aliases": wc?.current.aliases.length }
    : { rules: wc?.current.rules.length, aliases: wc?.current.aliases.length };

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

  // Warn before closing the tab with unsaved work (a reload keeps it; closing the tab doesn't).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [pending]);

  const conn = !site
    ? { cls: "unknown", text: "Not signed in to any site" }
    : site.signedIn
      ? { cls: "ok", text: `${site.user} · OPNsense ${site.info?.productVersion ?? "?"}` }
      : { cls: "err", text: "Signed out of this firewall" };
  const user = [...new Set(sites.filter((s) => s.signedIn).map((s) => s.user))].join(", ");
  const promptSite = sites.find((s) => s.id === ws.signInPrompt);
  const failedSites = Object.entries(signInErrors).filter(([id]) => !sites.find((s) => s.id === id)?.signedIn);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ▦
          </span>
          RuleDeck
        </div>
        <nav className="tabs-nav" aria-label="Main">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={activeTab.id === t.id ? "active" : ""}
              aria-current={activeTab.id === t.id ? "page" : undefined}
              onClick={() => setPage(t.pages[0]!.page)}
            >
              {t.label}
              {t.id === "changes" && pending > 0 && <span className="badge">{pending}</span>}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <button
            type="button"
            className={`pending-button${pending ? " has-pending" : ""}`}
            onClick={() => (ws.shared ? setPage("shared-apply") : setDrawerOpen((o) => !o))}
            aria-expanded={drawerOpen}
            aria-controls="changes-drawer"
          >
            {pending} pending{problems > 0 && <span className="text-error"> · {problems} ⚠</span>}
          </button>
          <button type="button" className="primary" disabled={!pending || problems > 0} onClick={() => setPage(ws.shared ? "shared-apply" : "changes")} title={problems ? "Fix problems first" : ws.shared ? "Review the changes per site, then apply to all sites" : "Review the changes before applying"}>
            {ws.shared ? "Review & apply to all" : "Review & apply"}
          </button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle theme">
            {theme === "dark" ? "☀ Light" : "☾ Dark"}
          </button>
          <div className="user">
            {user}{" "}
            {confirmSignOut ? (
              <span className="confirm-inline">
                Discard {pending} staged change{pending === 1 ? "" : "s"}?{" "}
                <button type="button" className="danger" onClick={onLogout}>
                  Sign out
                </button>
                <button type="button" onClick={() => setConfirmSignOut(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button type="button" className="link-button" onClick={() => (pending > 0 ? setConfirmSignOut(true) : onLogout())}>
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="body">
        {activeTab.tree && (
          <nav className="tree" aria-label={`${activeTab.label} sections`}>
            <h2>{activeTab.label}</h2>
            <ul>
              {activeTab.pages.map((p, i) => (
                <li key={p.page} className={p.group && p.group !== activeTab.pages[i - 1]?.group ? "tree-group-start" : undefined}>
                  {p.group && p.group !== activeTab.pages[i - 1]?.group && <div className="tree-group">{p.group}</div>}
                  <button type="button" className={page === p.page ? "active" : ""} aria-current={page === p.page ? "page" : undefined} onClick={() => setPage(p.page)}>
                    {p.label}
                    {counts[p.page] !== undefined && <span className="tree-count">{counts[p.page]}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
      <div className="main-col">
        <div className="toolbar" role="toolbar" aria-label="Site and edit actions">
          {ws.shared ? (
            <div className="fw-select">
              <span className="fw-name">Shared policy</span>
              <span className="muted">applies to {ws.shared.siteNames.join(" + ") || "all sites"}</span>
            </div>
          ) : sites.length > 1 ? (
            <label className="fw-select">
              <span className="sr-only">Site</span>
              <select className="site-select" value={ws.siteId ?? ""} onChange={(e) => ws.selectSite(e.target.value)} aria-label="Site">
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.signedIn ? "" : " (sign in…)"}
                  </option>
                ))}
              </select>
              <span className="muted">{site?.host}</span>
            </label>
          ) : (
            <div className="fw-select">
              <span className="fw-name">{site?.name ?? "No site"}</span>
              <span className="muted">{site?.host}</span>
            </div>
          )}
          {!ws.shared && (
            <span className={`conn conn-${conn.cls}`} role="status">
              <span className="dot" aria-hidden /> {conn.text}
            </span>
          )}
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
        </div>

        <HaBanner onGo={() => setPage("sites")} />

        {failedSites.length > 0 && !hideSignInErrors && (
          <div className="banner banner-warn" role="status">
            Not signed in to{" "}
            {failedSites.map(([id, e], i) => (
              <span key={id}>
                {i > 0 && ", "}
                <button type="button" className="link-button" onClick={() => ws.promptSignIn(id)}>
                  {sites.find((s) => s.id === id)?.name ?? id}
                </button>{" "}
                ({e.message})
              </span>
            ))}
            .{" "}
            <button type="button" className="link-button" onClick={() => setHideSignInErrors(true)}>
              Dismiss
            </button>
          </div>
        )}
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
          {!NEEDS_WORKING_COPY.has(page) ? (
            children
          ) : ws.loadError && !wc ? (
            <div className="banner banner-error" role="alert">
              {ws.loadError}{" "}
              <button type="button" onClick={() => void reload()}>
                Retry
              </button>
            </div>
          ) : !wc ? (
            <p className="muted pad">{loading ? "Loading firewall configuration…" : site ? "Not loaded." : "You're not signed in to any site. Open Sites to sign in."}</p>
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
      </div>

      {promptSite && (
        <SiteSignInDialog
          siteId={promptSite.id}
          siteName={promptSite.name}
          reason={promptSite.status === "signed_out" && promptSite.user ? "Your session on this firewall ended." : undefined}
          onCancel={() => ws.promptSignIn(null)}
          onDone={(s) => {
            ws.promptSignIn(null);
            ws.updateSession(s, promptSite.id);
          }}
        />
      )}

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
