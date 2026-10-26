import { useEffect, useState } from "react";
import { HaCell } from "../components/HaSwitch.tsx";
import { api, ApiError } from "../api.ts";
import { useWorkspace } from "../workspace.tsx";

export function OverviewPage({ go }: { go: (p: "rules" | "aliases" | "changes") => void }) {
  const { wc, site, changeSet, validation } = useWorkspace();
  const notes = site?.info?.features.notes ?? [];
  if (!wc) return null;
  const rules = wc.current.rules;
  const ro = rules.filter((r) => r.origin !== "mvc").length;
  return (
    <div className="overview">
      <div className="stat-row">
        <button type="button" className="stat" onClick={() => go("rules")}>
          <span className="stat-value">{rules.length}</span>
          <span className="stat-label">rules ({ro} read-only)</span>
        </button>
        <button type="button" className="stat" onClick={() => go("aliases")}>
          <span className="stat-value">{wc.current.aliases.length}</span>
          <span className="stat-label">aliases</span>
        </button>
        <button type="button" className="stat" onClick={() => go("changes")}>
          <span className="stat-value">{changeSet?.changes.length ?? 0}</span>
          <span className="stat-label">pending changes</span>
        </button>
        <div className="stat">
          <span className="stat-value">{validation?.errorCount ?? 0}</span>
          <span className="stat-label">problems</span>
        </div>
      </div>
      {notes.length > 0 && (
        <section>
          <h2>Notes for this firewall</h2>
          <ul>
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="muted">Loaded {new Date(wc.baseline.loadedAt).toLocaleString()}.</p>
    </div>
  );
}

export function SitesPage() {
  const { sites, siteId, selectSite, promptSignIn, updateSession, notify } = useWorkspace();
  const signOut = async (id: string) => {
    try {
      updateSession(await api.signOutSite(id));
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Sign-out failed.");
    }
  };
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Site</th>
            <th>Firewall</th>
            <th>Signed in as</th>
            <th>Version</th>
            <th>Editing</th>
            <th>HA</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sites.map((s) => (
            <tr key={s.id} className={s.id === siteId ? "row-current" : undefined}>
              <td>
                <strong>{s.name}</strong>
                {s.id === siteId && <span className="tag tag-reorder">open</span>}
              </td>
              <td className="mono">{s.host ?? "—"}</td>
              <td>{s.signedIn ? s.user : <span className="muted">not signed in</span>}</td>
              <td>{s.info?.productVersion ?? "—"}</td>
              <td>{s.info ? (s.info.features.rulesWrite ? "Supported" : <span title={s.info.features.notes.join(" ")}>Read-only</span>) : "—"}</td>
              <td>{s.hasSecondary ? s.signedIn ? <HaCell siteId={s.id} siteName={s.name} /> : "HA pair" : "single"}</td>
              <td className="row-actions">
                {s.signedIn ? (
                  <>
                    {s.id !== siteId && (
                      <button type="button" onClick={() => selectSite(s.id)}>
                        Open
                      </button>
                    )}
                    <button type="button" onClick={() => signOut(s.id)}>
                      Sign out
                    </button>
                  </>
                ) : (
                  <button type="button" className="primary" onClick={() => promptSignIn(s.id)}>
                    Sign in
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint pad">
        Sites are listed in the server's topology file. You sign in to each firewall with your own OPNsense account; RuleDeck stores no credentials and keeps
        your firewall sessions in memory only.
      </p>
    </div>
  );
}

export function HistoryPage() {
  const { applyHistory } = useWorkspace();
  return (
    <div className="settings">
      <h2>Where changes are recorded</h2>
      <p>
        RuleDeck keeps no log of its own. Every change it makes is saved by OPNsense under <strong>your OPNsense username</strong>, in{" "}
        <strong>System ▸ Configuration ▸ History</strong> on each firewall. That's also where you can compare and restore earlier revisions.
      </p>
      <h2>Applied from this tab</h2>
      {applyHistory.length === 0 ? (
        <p className="muted">Nothing applied in this tab yet. This list is kept in memory only and disappears when you close the tab.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Site</th>
              <th>As</th>
              <th>Outcome</th>
              <th>Written</th>
              <th>Activated</th>
              <th>Verified</th>
            </tr>
          </thead>
          <tbody>
            {applyHistory.map((h, i) => (
              <tr key={i}>
                <td>{new Date(h.at).toLocaleString()}</td>
                <td>{h.siteName}</td>
                <td>{h.user}</td>
                <td>
                  <span className={`tag tag-${h.result.outcome === "success" ? "success" : "failure"}`}>{h.result.outcome}</span>
                </td>
                <td>
                  {h.result.state.written}/{h.result.state.totalWrites}
                </td>
                <td>{h.result.state.activated ? "yes" : "no"}</td>
                <td>{h.result.state.verified ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { site } = useWorkspace();
  const f = site?.info?.features ?? null;
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    api.health().then((h) => setVersion(h.version), () => setVersion(null));
  }, []);
  return (
    <div className="settings">
      <h2>About</h2>
      <p>
        RuleDeck {version ?? ""} · open source under the MIT license ·{" "}
        <a href="https://github.com/famyfa/ruledesk" target="_blank" rel="noreferrer noopener">
          github.com/famyfa/ruledesk
        </a>
      </p>
      <h2>Firewall capabilities</h2>
      {f ? (
        <dl className="kv">
          <dt>Read rules</dt>
          <dd>{f.rulesRead ? "yes" : "no"}</dd>
          <dt>Write rules</dt>
          <dd>{f.rulesWrite ? "yes" : "no"}</dd>
          <dt>Write aliases</dt>
          <dd>{f.aliasesWrite ? "yes" : "no"}</dd>
        </dl>
      ) : (
        <p className="muted">Not connected.</p>
      )}
      <h2>Keyboard shortcuts</h2>
      <dl className="kv shortcuts">
        <dt>Arrows / Tab / Shift+Tab</dt>
        <dd>Move between cells</dd>
        <dt>Enter, F2, typing, second click</dt>
        <dd>Edit the active cell</dd>
        <dt>Enter / Tab</dt>
        <dd>Commit an edit (Enter in a picker adds the highlighted item; Enter on an empty picker finishes)</dd>
        <dt>Esc</dt>
        <dd>Cancel an edit / clear selection</dd>
        <dt>Space</dt>
        <dd>Toggle on/off cells, otherwise select the row</dd>
        <dt>Ctrl+C / Ctrl+V</dt>
        <dd>Copy / paste cells (tab-separated for multiple cells)</dd>
        <dt>Ctrl+D</dt>
        <dd>Clone rule</dd>
        <dt>Alt+↑ / Alt+↓</dt>
        <dd>Move rule within its group</dd>
        <dt>Insert</dt>
        <dd>Add a rule below</dd>
        <dt>Delete</dt>
        <dd>Delete selected rules (staged)</dd>
        <dt>Ctrl+Z / Ctrl+Y</dt>
        <dd>Undo / redo local edits</dd>
        <dt>Ctrl+I</dt>
        <dd>Show rule details</dd>
        <dt>Alt+N (in address picker)</dt>
        <dd>Toggle NOT</dd>
      </dl>
    </div>
  );
}
