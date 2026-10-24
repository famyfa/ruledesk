import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "./api.ts";
import { WorkspaceProvider } from "./workspace.tsx";
import { Shell, type Page } from "./components/Shell.tsx";
import { RulesPage } from "./pages/RulesPage.tsx";
import { AliasesPage } from "./pages/AliasesPage.tsx";
import { AuditPage, FirewallsPage, OverviewPage, SettingsPage } from "./pages/OtherPages.tsx";
import { ChangesPage } from "./pages/ChangesPage.tsx";

const PAGES: Page[] = ["overview", "firewalls", "rules", "aliases", "changes", "audit", "settings"];

function pageFromHash(): Page {
  const h = location.hash.replace(/^#\/?/, "") as Page;
  return PAGES.includes(h) ? h : "rules";
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("ruledeck.theme");
    if (saved === "light" || saved === "dark") return saved;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ruledeck.theme", theme);
  }, [theme]);
  return [theme, setTheme] as const;
}

export function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [page, setPageState] = useState<Page>(pageFromHash);
  const [focusRule, setFocusRule] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    api
      .session()
      .then((s) => setUser(s.user))
      .catch(() => setUser(null));
    const onHash = () => setPageState(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const setPage = useCallback((p: Page) => {
    location.hash = `/${p}`;
    setPageState(p);
  }, []);

  const showRule = useCallback(
    (id: string) => {
      setFocusRule(id);
      setPage("rules");
    },
    [setPage],
  );

  if (user === undefined) return <p className="muted pad">Loading…</p>;
  if (user === null) return <Login onLogin={setUser} />;

  return (
    <WorkspaceProvider>
      <Shell
        page={page}
        setPage={setPage}
        user={user}
        theme={theme}
        setTheme={setTheme}
        onShowRule={showRule}
        onLogout={async () => {
          await api.logout().catch(() => {});
          setUser(null);
        }}
      >
        {page === "rules" && <RulesPage key={focusRule ?? "rules"} initialActiveId={focusRule} />}
        {page === "aliases" && <AliasesPage onShowRule={showRule} />}
        {page === "changes" && <ChangesPage onShowRule={showRule} />}
        {page === "overview" && <OverviewPage go={setPage} />}
        {page === "firewalls" && <FirewallsPage />}
        {page === "audit" && <AuditPage />}
        {page === "settings" && <SettingsPage />}
      </Shell>
    </WorkspaceProvider>
  );
}

function Login({ onLogin }: { onLogin: (user: string) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(username, password);
      onLogin(r.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>
          <span className="brand-mark" aria-hidden>
            ▦
          </span>{" "}
          RuleDeck
        </h1>
        <p className="muted">Firewall policy editor for OPNsense</p>
        <label htmlFor="login-user">Username</label>
        <input id="login-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        <label htmlFor="login-pass">Password</label>
        <input id="login-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
