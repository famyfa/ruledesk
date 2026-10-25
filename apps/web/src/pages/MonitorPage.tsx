import { useEffect, useMemo, useRef, useState } from "react";
import { addFilterTerm, LOG_FILTER_FIELDS, logRecord, type FilterOp, type FirewallLogEntry } from "@ruledeck/core";
import { api, ApiError } from "../api.ts";
import { FilterInput, useFilter } from "../components/FilterInput.tsx";
import { useWorkspace } from "../workspace.tsx";

/**
 * Live firewall log of the primary firewall(s) (read-only): one site, or all
 * signed-in sites merged. Polls for lines newer than the newest one already
 * shown; nothing is stored.
 */

const POLL_MS = 3000;
const FIRST_LOAD = 300;
const POLL_LIMIT = 500;
const KEEP = 1000;
const LOG_ENV = { fields: LOG_FILTER_FIELDS };

type LogStatus = "loading" | "live" | "error";

interface SiteLog {
  entries: FirewallLogEntry[];
  status: LogStatus;
  error: { kind: string; message: string } | null;
  missed: boolean;
  lastPoll: Date | null;
}

const EMPTY: SiteLog = { entries: [], status: "loading", error: null, missed: false, lastPoll: null };

interface TaggedEntry {
  siteId: string;
  siteName: string;
  e: FirewallLogEntry;
}

function useFirewallLogs(siteIds: string[], paused: boolean, clearedAt: number) {
  const { sites, promptSignIn } = useWorkspace();
  const [logs, setLogs] = useState<Record<string, SiteLog>>({});
  const key = siteIds.join("|");
  // Newest line seen per site; survives pause/resume so no line is read twice.
  const newestRef = useRef<Record<string, string | undefined>>({});

  // Different sites (or a clear) start from scratch.
  useEffect(() => {
    newestRef.current = {};
    setLogs({});
  }, [key, clearedAt]);

  useEffect(() => {
    if (paused) return;
    const stops: (() => void)[] = [];
    for (const siteId of siteIds) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const patch = (fn: (s: SiteLog) => SiteLog) => setLogs((all) => ({ ...all, [siteId]: fn(all[siteId] ?? EMPTY) }));

      const tick = async () => {
        if (stopped) return;
        if (document.hidden) {
          timer = setTimeout(tick, POLL_MS); // don't hit the firewall from a background tab
          return;
        }
        try {
          const newest = newestRef.current[siteId];
          const first = newest === undefined;
          const res = await api.log(siteId, { limit: first ? FIRST_LOAD : POLL_LIMIT, digest: newest });
          if (stopped) return;
          if (res.entries.length) newestRef.current[siteId] = res.entries[0]!.digest;
          patch((s) => ({
            entries: res.entries.length ? [...res.entries, ...s.entries].slice(0, KEEP) : s.entries,
            status: "live",
            error: null,
            missed: s.missed || res.missed,
            lastPoll: new Date(),
          }));
          timer = setTimeout(tick, POLL_MS);
        } catch (err) {
          if (stopped) return;
          const body = err instanceof ApiError ? err.body : { kind: "unknown", message: "Couldn't read the log." };
          patch((s) => ({ ...s, status: "error", error: { kind: body.kind, message: body.message } }));
          if (body.kind === "site_signed_out" && body.siteId) {
            promptSignIn(body.siteId); // polling restarts when the session view changes after sign-in
            return;
          }
          if (body.kind === "forbidden" || body.kind === "unauthenticated") return; // retrying won't help
          timer = setTimeout(tick, POLL_MS * 2);
        }
      };
      void tick();
      stops.push(() => {
        stopped = true;
        if (timer) clearTimeout(timer);
      });
    }
    return () => stops.forEach((s) => s());
    // `sites` changes after (re-)signing in, which restarts polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, paused, clearedAt, sites, promptSignIn]);

  return logs;
}

function timeOf(t: string): string {
  const m = /^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)/.exec(t);
  return m ? m[1]! : t;
}

export function MonitorPage({ onShowRule }: { onShowRule: (ruleId: string) => void }) {
  const { site, sites, siteId, wc } = useWorkspace();
  const [scope, setScope] = useState<"site" | "all">(() => (sites.filter((s) => s.signedIn).length > 1 ? "all" : "site"));
  const [paused, setPaused] = useState(false);
  const [clearedAt, setClearedAt] = useState(0);
  const [expr, setExpr] = useState("");
  const signedIn = sites.filter((s) => s.signedIn);
  const watched = scope === "all" ? signedIn.map((s) => s.id) : siteId && site?.signedIn ? [siteId] : [];
  const logs = useFirewallLogs(watched, paused, clearedAt);
  const filter = useFilter(expr, LOG_ENV);

  // Match log lines to rules of the loaded policy: rule uuid, or the label of an automatic rule.
  const ruleByLogId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of wc?.current.rules ?? []) {
      const k = r.origin === "mvc" ? r.id : r.id.replace(/^legacy:/, "").replace(/#\d+$/, "");
      if (!map.has(k)) map.set(k, r.id);
    }
    return map;
  }, [wc]);

  const all = useMemo(() => {
    const tagged: TaggedEntry[] = [];
    for (const id of watched) {
      const name = sites.find((s) => s.id === id)?.name ?? id;
      for (const e of logs[id]?.entries ?? []) tagged.push({ siteId: id, siteName: name, e });
    }
    // Newest first across sites; the sort is stable, so one site's lines keep their order.
    return watched.length > 1 ? tagged.sort((a, b) => (a.e.time < b.e.time ? 1 : a.e.time > b.e.time ? -1 : 0)) : tagged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs, sites, watched.join("|")]);

  const shown = useMemo(() => all.filter((t) => filter.test(logRecord(t.e, t.siteName))), [all, filter]);

  if (!site?.signedIn && scope === "site") return <p className="muted pad">Sign in to a site to see its firewall log.</p>;

  const states = watched.map((id) => ({ id, name: sites.find((s) => s.id === id)?.name ?? id, log: logs[id] ?? EMPTY }));
  const errors = states.filter((s) => s.log.error);
  const missed = states.filter((s) => s.log.missed);
  const status: LogStatus = states.some((s) => s.log.status === "loading") ? "loading" : states.every((s) => s.log.status === "error") ? "error" : "live";
  const lastPoll = states.map((s) => s.log.lastPoll).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];

  /** Click = add `field eq value`; Shift+click = exclude it. */
  const addTerm = (e: React.MouseEvent, field: string, value: string) => {
    if (!value) return;
    const neg = e.shiftKey;
    setExpr((cur) => addFilterTerm(cur, field, (neg ? "neq" : "eq") as FilterOp, value));
  };
  const cellFilter = (field: string, value: string) => ({
    className: "cell-filter",
    title: `Click to filter ${field} = ${value} (Shift+click to exclude)`,
    onClick: (e: React.MouseEvent) => addTerm(e, field, value),
  });

  return (
    <div className="monitor-page">
      <div className="filter-bar" role="search">
        <select value={scope} onChange={(e) => setScope(e.target.value as "site" | "all")} aria-label="Log scope">
          <option value="site">This site{site ? `: ${site.name}` : ""}</option>
          <option value="all">All sites ({signedIn.length})</option>
        </select>
        <FilterInput value={expr} onChange={setExpr} fields={LOG_FILTER_FIELDS} error={filter.error} label="Filter log" />
        <button type="button" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        <button type="button" className="ghost" onClick={() => setClearedAt((n) => n + 1)} title="Clear the list and start again from the newest lines">
          Clear
        </button>
        {expr && (
          <button type="button" className="link-button" onClick={() => setExpr("")}>
            Clear filter
          </button>
        )}
        <span className="count" role="status">
          {paused ? "Paused" : status === "loading" ? "Loading…" : status === "error" ? "Not updating" : "● Live"} · {shown.length}
          {shown.length !== all.length ? ` of ${all.length}` : ""} lines
          {lastPoll && !paused && status === "live" ? ` · ${lastPoll.toLocaleTimeString()}` : ""}
        </span>
      </div>

      {errors.map((s) => (
        <div key={s.id} className="banner banner-error" role="alert">
          {watched.length > 1 ? `${s.name}: ` : ""}
          {s.log.error!.kind === "forbidden"
            ? "Your OPNsense user isn't allowed to read the firewall log. Ask for access to Firewall ▸ Log Files ▸ Live View."
            : s.log.error!.message}
        </div>
      ))}
      {missed.length > 0 && (
        <div className="banner banner-warn" role="status">
          {watched.length > 1 ? `${missed.map((s) => s.name).join(", ")}: s` : "S"}ome lines may be missing: the log moved faster than it was read, or it was rotated.
        </div>
      )}

      <div className="table-scroll">
        <table className="data-table log-table">
          <thead>
            <tr>
              <th>Time</th>
              {watched.length > 1 && <th>Site</th>}
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
            {shown.map(({ e, siteId: sid, siteName }, i) => {
              const ruleId = sid === siteId ? ruleByLogId.get(e.ruleId) : undefined;
              return (
                <tr key={`${sid}:${e.digest}:${i}`} className={`log-${e.action}`}>
                  <td className="mono" title={e.time}>
                    {timeOf(e.time)}
                  </td>
                  {watched.length > 1 && (
                    <td>
                      <span {...cellFilter("site", siteName)}>{siteName}</span>
                    </td>
                  )}
                  <td>
                    <span {...cellFilter("action", e.action)}>
                      <span className={`action action-${e.action === "block" ? "block" : "pass"}`}>{e.action}</span>
                    </span>
                  </td>
                  <td>{e.dir}</td>
                  <td className="mono">
                    <span {...cellFilter("interface", e.interface)}>{e.interface}</span>
                  </td>
                  <td>
                    <span {...cellFilter("proto", e.protocol)}>{e.protocol}</span>
                  </td>
                  <td className="mono">
                    <span {...cellFilter("addr.src", e.src)}>{e.src.includes(":") ? `[${e.src}]` : e.src}</span>
                    {e.srcPort && (
                      <>
                        :<span {...cellFilter("port.src", e.srcPort)}>{e.srcPort}</span>
                      </>
                    )}
                  </td>
                  <td className="mono">
                    <span {...cellFilter("addr.dst", e.dst)}>{e.dst.includes(":") ? `[${e.dst}]` : e.dst}</span>
                    {e.dstPort && (
                      <>
                        :<span {...cellFilter("port.dst", e.dstPort)}>{e.dstPort}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {ruleId ? (
                      <button type="button" className="link-button" onClick={() => onShowRule(ruleId)} title="Show this rule">
                        {e.ruleLabel || e.ruleId}
                      </button>
                    ) : e.ruleLabel ? (
                      <span {...cellFilter("rule", e.ruleLabel)}>{e.ruleLabel}</span>
                    ) : (
                      <span className="muted">{e.ruleId === "0" ? "default rule" : "—"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && status !== "loading" && (
          <div className="empty">
            {all.length ? "No lines match the filter." : "No log lines yet. Only rules with logging switched on (and the default block rule) write to this log."}
          </div>
        )}
      </div>
    </div>
  );
}
