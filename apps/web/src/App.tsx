import { useCallback, useEffect, useState } from "react";
import { api, setUnauthenticatedHandler, type ApiErrorBody, type SessionView } from "./api.ts";
import { clearDrafts, WorkspaceProvider } from "./workspace.tsx";
import { Shell, type Page } from "./components/Shell.tsx";
import { SignInPage } from "./components/SignIn.tsx";
import { RulesPage } from "./pages/RulesPage.tsx";
import { AliasesPage } from "./pages/AliasesPage.tsx";
import { HistoryPage, OverviewPage, SettingsPage, SitesPage } from "./pages/OtherPages.tsx";
import { ChangesPage } from "./pages/ChangesPage.tsx";

const PAGES: Page[] = ["overview", "sites", "rules", "aliases", "changes", "history", "settings"];

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
  const [session, setSession] = useState<SessionView | null | undefined>(undefined);
  const [signInErrors, setSignInErrors] = useState<Record<string, ApiErrorBody>>({});
  const [page, setPageState] = useState<Page>(pageFromHash);
  const [focusRule, setFocusRule] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    // RuleDeck session ended (idle, restart): show sign-in again. Staged drafts stay
    // in this tab's sessionStorage and come back after signing in.
    setUnauthenticatedHandler(() => setSession(null));
    api
      .session()
      .then(setSession)
      .catch(() => setSession(null));
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

  if (session === undefined) return <p className="muted pad">Loading…</p>;
  if (session === null) {
    return (
      <SignInPage
        onSignedIn={(s, errors) => {
          setSignInErrors(errors);
          setSession(s);
        }}
      />
    );
  }

  return (
    <WorkspaceProvider session={session} onSession={setSession}>
      <Shell
        page={page}
        setPage={setPage}
        theme={theme}
        setTheme={setTheme}
        onShowRule={showRule}
        signInErrors={signInErrors}
        onLogout={async () => {
          await api.logout().catch(() => {});
          clearDrafts();
          setSignInErrors({});
          setSession(null);
        }}
      >
        {page === "rules" && <RulesPage key={focusRule ?? "rules"} initialActiveId={focusRule} />}
        {page === "aliases" && <AliasesPage onShowRule={showRule} />}
        {page === "changes" && <ChangesPage onShowRule={showRule} />}
        {page === "overview" && <OverviewPage go={setPage} />}
        {page === "sites" && <SitesPage />}
        {page === "history" && <HistoryPage />}
        {page === "settings" && <SettingsPage />}
      </Shell>
    </WorkspaceProvider>
  );
}
