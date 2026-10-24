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
| Staged changes | Browser `sessionStorage` (this tab only, cleared at sign-out) | Not secret, but describe the planned policy |
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

## OPNsense users and privileges

Use personal accounts, so config history shows who changed what. A user needs:

- `Firewall: Rules [new]` (firewall/filter)
- `Firewall: Alias: Edit` (firewall/alias)
- `System: Firmware` (read), for version detection. Without it, RuleDeck can read but won't edit, because it can't check compatibility.
- For multi-site HA (Phase 7): the HA sync privileges

Users without write privileges can still sign in and browse; their applies fail with a clear "lacks the privilege" message. The exact privilege names differ slightly between releases; this list will be checked once the live tests run.

## Configuration

| Setting | Meaning |
|---|---|
| `RULEDECK_TOPOLOGY_FILE` | Read-only JSON listing sites, primary/secondary URLs, CA files and (later) interface maps. No secrets. See `ruledeck.topology.example.json` |
| `RULEDECK_ALLOW_WRITES` | `true` to allow applying changes. Default `false` |
| `RULEDECK_COOKIE_SECURE` | Default `true` in production |

Settings from earlier versions (`RULEDECK_ADMIN_*`, `RULEDECK_DATA_DIR`, `OPNSENSE_URL/API_KEY/API_SECRET/CA_FILE`) are refused at startup, so no secret is left lying around in an env file.
