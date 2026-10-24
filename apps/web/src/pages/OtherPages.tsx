import { useEffect, useState } from "react";
import { api, ApiError, type AuditEvent } from "../api.ts";
import { useWorkspace } from "../workspace.tsx";

export function OverviewPage({ go }: { go: (p: "rules" | "aliases" | "changes") => void }) {
  const { wc, connection, changeSet, validation } = useWorkspace();
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
      {connection.status === "connected" && connection.info.features.notes.length > 0 && (
        <section>
          <h2>Notes for this firewall</h2>
          <ul>
            {connection.info.features.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="muted">Loaded {new Date(wc.baseline.loadedAt).toLocaleString()}.</p>
    </div>
  );
}

export function FirewallsPage() {
  const { firewalls, connection } = useWorkspace();
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Host</th>
            <th>Status</th>
            <th>Version</th>
            <th>Editing</th>
          </tr>
        </thead>
        <tbody>
          {firewalls.map((f) => (
            <tr key={f.id}>
              <td>{f.name}</td>
              <td className="mono">{f.host}</td>
              <td>{connection.status === "connected" ? "Connected" : connection.status === "error" ? `Error: ${connection.error.message}` : "Unknown"}</td>
              <td>{connection.status === "connected" ? connection.info.productVersion : "—"}</td>
              <td>{connection.status === "connected" ? (connection.info.features.rulesWrite ? "Supported" : "Read-only") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint pad">Firewalls are configured on the server (environment variables). The browser never sees API credentials.</p>
    </div>
  );
}

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .audit()
      .then((r) => setEvents(r.events))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load the audit log."));
  }, []);
  if (error) return <div className="banner banner-error">{error}</div>;
  if (!events) return <p className="muted pad">Loading…</p>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Action</th>
            <th>Outcome</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.at).toLocaleString()}</td>
              <td>{e.user}</td>
              <td className="mono">{e.action}</td>
              <td>
                <span className={`tag tag-${e.outcome}`}>{e.outcome}</span>
              </td>
              <td className="mono small">{JSON.stringify(e.details)}</td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No events yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function SettingsPage() {
  const { connection } = useWorkspace();
  const f = connection.status === "connected" ? connection.info.features : null;
  return (
    <div className="settings">
      <h2>Firewall capabilities</h2>
      {f ? (
        <dl className="kv">
          <dt>Read rules</dt>
          <dd>{f.rulesRead ? "yes" : "no"}</dd>
          <dt>Write rules</dt>
          <dd>{f.rulesWrite ? "yes" : "no"}</dd>
          <dt>Write aliases</dt>
          <dd>{f.aliasesWrite ? "yes" : "no"}</dd>
          <dt>Automatic rollback timer</dt>
          <dd>{f.rollbackTimer ? "available" : "not available on this version"}</dd>
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
