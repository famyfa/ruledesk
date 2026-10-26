# Security and threat model

**RuleDeck stores nothing.** There is no database, no stored credential and no local user. People sign in with their own OPNsense account, and each firewall decides who they are and what they may change. RuleDeck holds only the resulting firewall sessions, in server memory, for as long as the RuleDeck session lives.

Still treat the RuleDeck host as sensitive: while someone is signed in, its memory holds a session that can change the firewall.

## How sign-in works

1. The browser sends the username and password (or an API key) for one or more sites to `POST /api/auth/login`.
2. For each site, the server signs in to the site's **primary firewall** the way a browser does. It loads the OPNsense login page, posts `usernamefld`/`passwordfld` with the page's CSRF field, and receives a GUI session cookie (`authgui.inc`, "WebGui" authenticator). So local users, LDAP, RADIUS and TOTP work exactly as they do in the OPNsense UI. SSO that needs a browser redirect (SAML/OIDC) can't work this way. For those setups, use an API key.
3. The server proves the session works by listing one rule (OPNsense has no "whoami"), and reads the version.
4. **The password is used once and then dropped.** The server keeps only the firewall's session cookie and CSRF token, inside an `OpnsenseClient` in memory.
5. API calls use that session (`Cookie` + `X-CSRFToken`), the same mechanism the OPNsense web UI uses. OPNsense checks the user's privileges on every call and **records every change under that username** in its config history.

When the firewall's own session times out (System ▸ Settings ▸ Administration, default 4 h), RuleDeck asks for the password again for that site only. Staged changes are kept.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| User passwords | Only in the login request; never kept | Grant everything the user can do on the firewall |
| Firewall GUI sessions / API keys | Server memory, per RuleDeck session | Allow changes as that user until the session ends |
| RuleDeck session cookie | Browser (HttpOnly) | Lets the holder use the firewall sessions above |
| Staged changes | Browser `sessionStorage` (this tab only, cleared at sign-out) | Not secret, but describe the planned policy. Typed passwords/keys of services are **not** stored there (memory only) |
| Secrets inside firewall config (CARP passwords, DDNS keys, WireGuard keys, user hashes, certificate private keys) | The firewalls | Never needed in the browser. RuleDeck drops them on the server |
| Firewall configuration | The firewalls | Wrong rules can expose networks or lock admins out |

## Trust boundaries

1. Browser ⇄ RuleDeck server: untrusted client. Every input is validated (zod). Every state-changing request needs a valid session and CSRF token.
2. RuleDeck server ⇄ OPNsense: only the server talks to firewalls, and only to URLs in the topology file. Responses are validated before use.

## Threats and mitigations

| # | Threat | Mitigation |
|---|---|---|
| T1 | Credentials leak to the browser | Passwords are never stored. Firewall cookies and API secrets never leave the server: no endpoint returns them (tested). Errors are mapped to sanitized messages |
| T2 | Credentials in logs | Logger redacts `authorization`, `cookie`, CSRF headers and the password/apiKey/apiSecret fields of login bodies. RuleDeck writes one log line per apply (site, user, counts, outcome), never field values |
| T3 | MITM between RuleDeck and OPNsense | TLS verification is always on. Firewalls with a private CA use `caFile` in the topology. Plain HTTP only works for loopback (the mock). **There is no "insecure" switch** |
| T4 | SSRF / credential relay | Users can't choose URLs. RuleDeck only connects to the URLs in the operator's read-only topology file. API paths come from a fixed list. Path parameters are validated and encoded |
| T5 | Unauthorized UI access | Every `/api/*` route except health, topology and login needs a RuleDeck session. That session exists only after a firewall accepted the credentials |
| T6 | Session theft | Random 256-bit session id, `HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS. Idle timeout 30 min, absolute 8 h, at most 50 sessions. Ending a session also logs out of the firewalls |
| T7 | CSRF | `SameSite=Strict` plus a per-session token in `X-CSRF-Token` on every non-GET request |
| T8 | Password guessing through RuleDeck | Failed sign-ins are limited per (IP, site) to 5/min. OPNsense's own login protection (and its auth log) still applies |
| T9 | Accidental destructive change | Changes are staged locally. Apply needs explicit confirmation on a review screen. Deleting a referenced alias requires acknowledging the impact |
| T10 | Admin lockout | The review screen flags risky changes (heuristics in `packages/core/src/risk.ts`), and apply needs an extra acknowledgement for them. There is deliberately no automatic rollback; recovery is the firewall's config history |
| T11 | Silent overwrite of someone else's change | Fingerprint-based conflict detection before every apply. On conflict nothing is written |
| T12 | Public exposure | Compose binds to `127.0.0.1` only. Use a TLS reverse proxy on the management network; never expose RuleDeck to the internet |
| T13 | Server memory disclosure (heap dump, compromised host) | Short sessions, logout clears clients, no core dumps in the container, least-privilege OPNsense users. Residual risk: JS can't wipe strings from memory |
| T14 | Accidental writes to a real firewall during development | `RULEDECK_ALLOW_WRITES` is off by default; the dev config turns it on only for the mocks |
| T15 | Repeated or concurrent applies | One apply at a time per site. Apply is rate-limited per session (`RULEDECK_APPLY_RATE_LIMIT`, default 10/min) |
| T16 | DNS-rebind protection blocks sign-in | Use the firewall's IP or a hostname listed in its Alternate Hostnames. RuleDeck shows this explicitly |
| T17 | Secrets from the firewall's configuration reach the browser | Service reads drop every field whose name looks like a secret (password, secret, key, PSK, token, community, OTP seed, …) on the server; they become write-only inputs. The certificate list is whitelisted field by field, because OPNsense returns private keys in it. Firewall log rows are whitelisted too (tested) |
| T18 | A misbehaving or hostile firewall exhausts the server | Answers from firewalls are read with a 64 MB cap (login pages: 512 KB), checked while streaming. Tables over 500 entries are not loaded |
| T19 | Pinned certificate bypass | With `tlsFingerprint`, every connection does a full handshake (no TLS session resumption) and the SHA-256 fingerprint is compared before any request is sent |
| T20 | Multi-site apply leaves sites inconsistent | Every site is checked before anything is written; sites are written one at a time and the first failure stops the run. The result names exactly which sites have the change. No automatic rollback (decided) |
| T21 | HA switchover sent twice (it's a toggle on OPNsense) | Read state first, send once, read back; never retried |
| T22 | Clickjacking, content sniffing, cross-origin leaks | CSP (`default-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, `Permissions-Policy`, `Cache-Control: no-store`; HSTS when served over HTTPS |

## OPNsense users and privileges

Use personal accounts, so config history shows who changed what. A user needs:

- `Firewall: Rules [new]` (firewall/filter)
- `Firewall: Alias: Edit` (firewall/alias)
- `System: Firmware` (read), for version detection. Without it, RuleDeck can read but won't edit, because it can't check compatibility.
- For multi-site HA (Phase 7): the HA sync privileges

For services, the user needs the privilege of each service's pages (e.g. `Services: Kea DHCPv4`, `Services: Unbound DNS`, `System: Gateways`); for the HA switch `Status: CARP` / `Diagnostics` (interface), for the log `Firewall: Log Files: Live View`, for certificates `System: Certificates`. Give people only what they need: RuleDeck can never do more than the signed-in OPNsense user.

Users without write privileges can still sign in and browse; their applies fail with a clear "lacks the privilege" message. The exact privilege names differ slightly between releases; this list will be checked once the live tests run.

## Configuration

| Setting | Meaning |
|---|---|
| `RULEDECK_TOPOLOGY_FILE` | Read-only JSON listing sites, primary/secondary URLs, CA files and (later) interface maps. No secrets. See `ruledeck.topology.example.json` |
| `RULEDECK_ALLOW_WRITES` | `true` to allow applying changes. Default `false` |
| `RULEDECK_COOKIE_SECURE` | Default `true` in production |

Settings from earlier versions (`RULEDECK_ADMIN_*`, `RULEDECK_DATA_DIR`, `OPNSENSE_URL/API_KEY/API_SECRET/CA_FILE`) are refused at startup, so no secret is left lying around in an env file.

| `RULEDECK_TRUST_PROXY` | `true` only behind a reverse proxy that **overwrites** `X-Forwarded-For`. Otherwise clients could pick their own IP and get around the per-IP sign-in limit (the per-site hourly limit still applies) |

## Security review (2026-10-26)

A review of the whole code base (server, firewall client, web app, container) before the first release. `npm audit`: 0 vulnerabilities.

**Fixed**

| Severity | Finding | Fix |
|---|---|---|
| Medium | Passwords/keys typed into a service form were saved with the staged draft in the browser's `sessionStorage` (readable by any script on the origin) | Drafts are saved without secret fields; a typed secret lives only in memory until applied (E2E test) |
| Low | Answers from a firewall were read without a size limit | 64 MB cap, checked while streaming; 512 KB for the login page (tests) |
| Low | The interface map (internal keys and labels) was visible before sign-in | Only for signed-in users (test) |
| Low | Missing `Strict-Transport-Security`, COOP/CORP and `Permissions-Policy` headers | Added; HSTS only when served over HTTPS (test) |
| Low | `docker stop` did not end the firewall GUI sessions | SIGTERM/SIGINT close the server cleanly, which logs out of every firewall |

**Checked, no finding**

Session handling (256-bit ids, rotation when privileges grow, idle/absolute timeouts, no eviction of others); CSRF on every state-changing route (matched by route pattern, so encoded paths can't skip it); login CSRF (JSON-only bodies, no CORS); input validation (zod on every body and parameter, safe path segments to the firewall); no URL can be chosen by users (no SSRF); TLS verification always on, pinning without session resumption; no secrets in logs or responses; no XSS sinks in the web app (no `innerHTML`, no URLs built from firewall data); writes off by default; read-only services refused on the server; container runs as non-root, read-only, all capabilities dropped, bound to localhost.

**Accepted (by design) and residual risks**

- The per-site hourly limit on failed password sign-ins (default 4) is shared by everyone, to keep RuleDeck's address out of OPNsense's lockout. Someone who can reach RuleDeck can therefore block password sign-ins *through RuleDeck* for an hour. Sign-in with an API key and direct sign-in to the firewall are not affected.
- Secret detection for services is by field name. A service with an unusually named secret field could expose it to a signed-in user who may read that service on the firewall anyway. New services must be checked when they're added to the catalogue (the certificate list is whitelisted for this reason).
- A signed-in user can make RuleDeck read large parts of a firewall's configuration (that is the product); reads are not rate-limited except the live log.
- Firewall sessions and API keys stay in server memory while a user is signed in (at most 8 h). JavaScript can't wipe strings from memory.
- RuleDeck is meant for a management network behind a TLS reverse proxy. It is not hardened for direct internet exposure.

