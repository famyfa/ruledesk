import { useCallback, useEffect, useMemo, useState } from "react";
import { certStatus, daysLeft, type CertificateInfo, type CertStatus } from "@ruledeck/core";
import { api, ApiError } from "../api.ts";
import { useWorkspace } from "../workspace.tsx";

/**
 * Certificates and CAs of all signed-in sites with their expiry, soonest first.
 * Read-only: private keys and certificate files are never requested by the browser
 * and are dropped by the server.
 */

interface Row extends CertificateInfo {
  siteId: string;
  siteName: string;
}

const STATUS_TEXT: Record<CertStatus, string> = { expired: "expired", expiring: "expires soon", ok: "valid", unknown: "unknown" };
const STATUS_CLASS: Record<CertStatus, string> = { expired: "tag-failure", expiring: "tag-partial", ok: "tag-success", unknown: "tag-step-skipped" };

export function CertificatesPage() {
  const { sites } = useWorkspace();
  const signedIn = useMemo(() => sites.filter((s) => s.signedIn), [sites]);
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const all: Row[] = [];
    const errs: Record<string, string> = {};
    await Promise.all(
      signedIn.map(async (s) => {
        try {
          const { certificates } = await api.certificates(s.id);
          all.push(...certificates.map((c) => ({ ...c, siteId: s.id, siteName: s.name })));
        } catch (e) {
          errs[s.id] = e instanceof ApiError ? e.message : "Couldn't read the certificates.";
        }
      }),
    );
    all.sort((a, b) => (daysLeft(a) ?? 1e9) - (daysLeft(b) ?? 1e9));
    setRows(all);
    setErrors(errs);
    setLoading(false);
  }, [signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = rows.filter((r) => !onlyProblems || certStatus(r) === "expired" || certStatus(r) === "expiring");
  const problems = rows.filter((r) => ["expired", "expiring"].includes(certStatus(r))).length;

  if (!signedIn.length) return <p className="muted pad">Sign in to a site to see its certificates.</p>;

  return (
    <div className="certs-page">
      <div className="filter-bar">
        <label className="checkbox">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Only expired or expiring (30 days)
        </label>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "Reading…" : "↻ Refresh"}
        </button>
        <span className="count" role="status">
          {problems ? `${problems} need attention · ` : ""}
          {shown.length} of {rows.length} certificates
        </span>
      </div>
      {Object.entries(errors).map(([id, msg]) => (
        <div key={id} className="banner banner-error" role="alert">
          {sites.find((s) => s.id === id)?.name}: {msg}
        </div>
      ))}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Site</th>
              <th>Name</th>
              <th>Common name</th>
              <th>Kind</th>
              <th>Valid until</th>
              <th>Days left</th>
              <th>Status</th>
              <th>In use</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const st = certStatus(r);
              const d = daysLeft(r);
              return (
                <tr key={`${r.siteId}:${r.uuid}`}>
                  <td>{r.siteName}</td>
                  <td>
                    <b>{r.description || r.refid}</b>
                  </td>
                  <td className="mono" title={r.altNames.join("\n")}>
                    {r.commonName || "—"}
                    {r.altNames.length > 0 && <span className="muted"> +{r.altNames.length}</span>}
                  </td>
                  <td>{r.isCa ? "CA" : r.type || "certificate"}</td>
                  <td className="mono">{r.validTo ? r.validTo.slice(0, 10) : "—"}</td>
                  <td>{d === null ? "—" : d}</td>
                  <td>
                    <span className={`tag ${STATUS_CLASS[st]}`}>{STATUS_TEXT[st]}</span>
                  </td>
                  <td>{r.inUse ? "yes" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && shown.length === 0 && <div className="empty">{rows.length ? "Nothing needs attention." : "No certificates found."}</div>}
      </div>
    </div>
  );
}
