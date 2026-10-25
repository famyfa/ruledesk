import { useEffect, useMemo, useRef, useState } from "react";
import type { FirewallLogEntry } from "@ruledeck/core";
import { api, ApiError } from "../api.ts";
import { useWorkspace } from "../workspace.tsx";

/**
 * Live firewall log of the selected site's primary firewall (read-only).
 * Polls for lines newer than the newest one already shown; nothing is stored.
 */

const POLL_MS = 3000;
const FIRST_LOAD = 300;
const POLL_LIMIT = 500;
const KEEP = 1000;

type LogStatus = "loading" | "live" | "error";

function useFirewallLog(siteId: string | null, paused: boolean) {
  const { sites, promptSignIn } = useWorkspace();
  const [entries, setEntries] = useState<FirewallLogEntry[]>([]);
  const [status, setStatus] = useState<LogStatus>("loading");
  const [error, setError] = useState<{ kind: string; message: string } | null>(null);
  const [missed, setMissed] = useState(false);
  const [lastPoll, setLastPoll] = useState<Date | null>(null);
  const newest = useRef<string | undefined>(undefined);
  const [clearedAt, setClearedAt] = useState(0);

  // A different site (or a fresh sign-in) starts from scratch.
  useEffect(() => {
    newest.current = undefined;
    setEntries([]);
    setMissed(false);
    setError(null);
    setStatus("loading");
  }, [siteId, clearedAt]);

  useEffect(() => {
    if (!siteId || paused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (stopped) return;
      if (document.hidden) {
        timer = setTimeout(tick, POLL_MS); // don't hit the firewall from a background tab
        return;
      }
      try {
        const first = newest.current === undefined;
        const res = await api.log(siteId, { limit: first ? FIRST_LOAD : POLL_LIMIT, digest: newest.current });
        if (stopped) return;
        if (res.entries.length) {
          newest.current = res.entries[0]!.digest;
          setEntries((prev) => [...res.entries, ...prev].slice(0, KEEP));
        } else if (first) {
          newest.current = undefined;
        }
        if (res.missed) setMissed(true);
        setError(null);
        setStatus("live");
        setLastPoll(new Date());
        timer = setTimeout(tick, POLL_MS);
      } catch (err) {
        if (stopped) return;
        const body = err instanceof ApiError ? err.body : { kind: "unknown", message: "Couldn't read the log." };
        setError({ kind: body.kind, message: body.message });
        setStatus("error");
        if (body.kind === "site_signed_out" && body.siteId) {
          promptSignIn(body.siteId); // polling restarts when the session view changes after sign-in
          return;
        }
        if (body.kind === "forbidden" || body.kind === "unauthenticated") return; // retrying won't help
        timer = setTimeout(tick, POLL_MS * 2);
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // `sites` changes after (re-)signing in, which restarts polling.
  }, [siteId, paused, clearedAt, sites, promptSignIn]);

  return {
    entries,
    status,
    error,
    missed,
    lastPoll,
    clear: () => setClearedAt((n) => n + 1),
  };
}

const ipPort = (ip: string, port: string) => {
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return port ? `${host}:${port}` : host;
};

function timeOf(t: string): string {
  const m = /^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)/.exec(t);
  return m ? m[1]! : t;
}

export function MonitorPage({ onShowRule }: { onShowRule: (ruleId: string) => void }) {
  const { site, siteId, wc } = useWorkspace();
  const [paused, setPaused] = useState(false);
  const [text, setText] = useState("");
  const [action, setAction] = useState("");
  const [dir, setDir] = useState("");
  const log = useFirewallLog(siteId, paused);

  // Match log lines to rules of the loaded policy: rule uuid, or the label of an automatic rule.
  const ruleByLogId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of wc?.current.rules ?? []) {
      const key = r.origin === "mvc" ? r.id : r.id.replace(/^legacy:/, "").replace(/#\d+$/, "");
      if (!map.has(key)) map.set(key, r.id);
    }
    return map;
  }, [wc]);

  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    return log.entries.filter((e) => {
      if (action && e.action !== action) return false;
      if (dir && e.dir !== dir) return false;
      if (!q) return true;
      return [e.src, e.srcPort, e.dst, e.dstPort, e.protocol, e.interface, e.ruleLabel, e.action].some((v) => v.toLowerCase().includes(q));
    });
  }, [log.entries, text, action, dir]);

  if (!site?.signedIn) return <p className="muted pad">Sign in to a site to see its firewall log.</p>;

  return (
    <div className="monitor-page">
      <div className="filter-bar" role="search">
        <input type="search" placeholder="Filter log: address, port, rule, interface…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter log" />
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action filter">
          <option value="">All actions</option>
          <option value="pass">pass</option>
          <option value="block">block</option>
        </select>
        <select value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Direction filter">
          <option value="">In and out</option>
          <option value="in">in</option>
          <option value="out">out</option>
        </select>
        <button type="button" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        <button type="button" className="ghost" onClick={log.clear} title="Clear the list and start again from the newest lines">
          Clear
        </button>
        <span className="count" role="status">
          {paused ? "Paused" : log.status === "loading" ? "Loading…" : log.status === "error" ? "Not updating" : "● Live"} · {shown.length}
          {shown.length !== log.entries.length ? ` of ${log.entries.length}` : ""} lines
          {log.lastPoll && !paused && log.status === "live" ? ` · ${log.lastPoll.toLocaleTimeString()}` : ""}
        </span>
      </div>

      {log.error && (
        <div className="banner banner-error" role="alert">
          {log.error.kind === "forbidden"
            ? "Your OPNsense user isn't allowed to read the firewall log. Ask for access to Firewall ▸ Log Files ▸ Live View."
            : log.error.message}
        </div>
      )}
      {log.missed && (
        <div className="banner banner-warn" role="status">
          Some lines may be missing: the log moved faster than it was read, or it was rotated.
        </div>
      )}

      <div className="table-scroll">
        <table className="data-table log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Dir</th>
              <th>Interface</th>
              <th>Proto</th>
              <th>Source</th>
              <th>Destination</th>
              <th>Rule</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e, i) => {
              const ruleId = ruleByLogId.get(e.ruleId);
              return (
                <tr key={`${e.digest}:${i}`} className={`log-${e.action}`}>
                  <td className="mono" title={e.time}>
                    {timeOf(e.time)}
                  </td>
                  <td>
                    <span className={`action action-${e.action === "block" ? "block" : "pass"}`}>{e.action}</span>
                  </td>
                  <td>{e.dir}</td>
                  <td className="mono">{e.interface}</td>
                  <td>{e.protocol}</td>
                  <td className="mono">{ipPort(e.src, e.srcPort)}</td>
                  <td className="mono">{ipPort(e.dst, e.dstPort)}</td>
                  <td>
                    {ruleId ? (
                      <button type="button" className="link-button" onClick={() => onShowRule(ruleId)} title="Show this rule">
                        {e.ruleLabel || e.ruleId}
                      </button>
                    ) : e.ruleLabel ? (
                      e.ruleLabel
                    ) : (
                      <span className="muted">{e.ruleId === "0" ? "default rule" : "—"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && log.status !== "loading" && (
          <div className="empty">
            {log.entries.length
              ? "No lines match the filter."
              : "No log lines yet. Only rules with logging switched on (and the default block rule) write to this log."}
          </div>
        )}
      </div>
    </div>
  );
}
