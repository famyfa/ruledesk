import { useEffect, useId, useState, type FormEvent } from "react";
import { api, ApiError, parseApiKeyFile, type ApiErrorBody, type PublicTopology, type SessionView, type SiteLogin } from "../api.ts";

/** Fields for one site's credentials (OPNsense username/password, or an API key). */
interface Creds {
  method: "password" | "apikey";
  username: string;
  password: string;
  apiKey: string;
  apiSecret: string;
}

const EMPTY: Creds = { method: "password", username: "", password: "", apiKey: "", apiSecret: "" };

function toLogin(c: Creds): SiteLogin | null {
  if (c.method === "password") return c.username && c.password ? { method: "password", username: c.username, password: c.password } : null;
  return c.apiKey && c.apiSecret ? { method: "apikey", apiKey: c.apiKey, apiSecret: c.apiSecret } : null;
}

export function CredentialFields({ value, onChange, idPrefix }: { value: Creds; onChange: (c: Creds) => void; idPrefix: string }) {
  const [pasteError, setPasteError] = useState<string | null>(null);
  return (
    <div className="cred-fields">
      <div className="segmented" role="radiogroup" aria-label="Sign-in method">
        <button type="button" role="radio" aria-checked={value.method === "password"} className={value.method === "password" ? "active" : ""} onClick={() => onChange({ ...value, method: "password" })}>
          Username &amp; password
        </button>
        <button type="button" role="radio" aria-checked={value.method === "apikey"} className={value.method === "apikey" ? "active" : ""} onClick={() => onChange({ ...value, method: "apikey" })}>
          API key
        </button>
      </div>
      {value.method === "password" ? (
        <>
          <label htmlFor={`${idPrefix}-user`}>Username</label>
          <input id={`${idPrefix}-user`} value={value.username} onChange={(e) => onChange({ ...value, username: e.target.value })} autoComplete="username" />
          <label htmlFor={`${idPrefix}-pass`}>Password</label>
          <input id={`${idPrefix}-pass`} type="password" value={value.password} onChange={(e) => onChange({ ...value, password: e.target.value })} autoComplete="current-password" />
        </>
      ) : (
        <>
          <label htmlFor={`${idPrefix}-key`}>API key</label>
          <input id={`${idPrefix}-key`} value={value.apiKey} onChange={(e) => onChange({ ...value, apiKey: e.target.value })} autoComplete="off" spellCheck={false} />
          <label htmlFor={`${idPrefix}-secret`}>API secret</label>
          <input id={`${idPrefix}-secret`} type="password" value={value.apiSecret} onChange={(e) => onChange({ ...value, apiSecret: e.target.value })} autoComplete="off" />
          <label htmlFor={`${idPrefix}-paste`} className="hint">
            …or paste the downloaded apikey.txt
          </label>
          <textarea
            id={`${idPrefix}-paste`}
            rows={2}
            placeholder={"key=...\nsecret=..."}
            onChange={(e) => {
              const parsed = parseApiKeyFile(e.target.value);
              setPasteError(e.target.value && !parsed ? "That doesn't look like an apikey.txt file." : null);
              if (parsed) {
                onChange({ ...value, ...parsed });
                e.target.value = "";
              }
            }}
          />
          {pasteError && <p className="field-error">{pasteError}</p>}
        </>
      )}
    </div>
  );
}

/** Full sign-in page: one card per site. */
export function SignInPage({ onSignedIn }: { onSignedIn: (s: SessionView, errors: Record<string, ApiErrorBody>) => void }) {
  const id = useId();
  const [topology, setTopology] = useState<PublicTopology | null>(null);
  const [same, setSame] = useState(true);
  const [shared, setShared] = useState<Creds>(EMPTY);
  const [perSite, setPerSite] = useState<Record<string, Creds>>({});
  const [errors, setErrors] = useState<Record<string, ApiErrorBody>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.topology().then(setTopology).catch(() => setError("Can't reach the RuleDeck server."));
  }, []);

  const credsFor = (siteId: string) => (same ? shared : (perSite[siteId] ?? EMPTY));
  const logins = topology ? Object.fromEntries(topology.sites.flatMap((s) => {
    const l = toLogin(credsFor(s.id));
    return l ? [[s.id, l]] : [];
  })) : {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const r = await api.login(logins);
      onSignedIn(r, r.siteErrors);
    } catch (err) {
      if (err instanceof ApiError && err.extra.siteErrors) setErrors(err.extra.siteErrors as Record<string, ApiErrorBody>);
      setError(err instanceof ApiError ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!topology) return <div className="login-wrap">{error ? <p className="field-error">{error}</p> : <p className="muted">Loading…</p>}</div>;
  const multi = topology.sites.length > 1;

  return (
    <div className="login-wrap">
      <form className="login login-wide" onSubmit={submit}>
        <h1>
          <span className="brand-mark" aria-hidden>
            ▦
          </span>{" "}
          RuleDeck
        </h1>
        <p className="muted">Sign in with your OPNsense account. Your firewall decides who you are and what you may change (local users, LDAP, RADIUS, TOTP).</p>

        {multi && (
          <label className="checkbox">
            <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
            Use the same sign-in for all {topology.sites.length} sites
          </label>
        )}

        {same ? (
          <fieldset className="site-card">
            <legend>{multi ? topology.sites.map((s) => s.name).join(" · ") : topology.sites[0]!.name}</legend>
            <CredentialFields value={shared} onChange={setShared} idPrefix={`${id}-all`} />
          </fieldset>
        ) : (
          topology.sites.map((s) => (
            <fieldset className="site-card" key={s.id}>
              <legend>{s.name}</legend>
              <CredentialFields value={perSite[s.id] ?? EMPTY} onChange={(c) => setPerSite({ ...perSite, [s.id]: c })} idPrefix={`${id}-${s.id}`} />
              <p className="hint">Leave empty to skip this site for now.</p>
            </fieldset>
          ))
        )}

        {Object.keys(errors).length > 0 && (
          <ul className="site-errors" role="alert">
            {Object.entries(errors).map(([siteId, e]) => (
              <li key={siteId}>
                ✗ <strong>{topology.sites.find((s) => s.id === siteId)?.name ?? siteId}</strong>: {e.message}
              </li>
            ))}
          </ul>
        )}
        {error && Object.keys(errors).length === 0 && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy || Object.keys(logins).length === 0}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="hint">Nothing is stored. RuleDeck holds only your firewall session in memory until you sign out or are idle for 30 minutes.</p>
      </form>
    </div>
  );
}

/** Small dialog to sign in to one site (again). */
export function SiteSignInDialog({ siteId, siteName, reason, onDone, onCancel }: { siteId: string; siteName: string; reason?: string; onDone: (s: SessionView) => void; onCancel: () => void }) {
  const id = useId();
  const [creds, setCreds] = useState<Creds>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const login = toLogin(creds);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!login) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.signInSite(siteId, login));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <form className="login modal" role="dialog" aria-label={`Sign in to ${siteName}`} onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
        <h2>Sign in to {siteName}</h2>
        {reason && <p className="muted">{reason}</p>}
        <CredentialFields value={creds} onChange={setCreds} idPrefix={id} />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!login || busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
        <p className="hint">Your staged changes are kept.</p>
      </form>
    </div>
  );
}
