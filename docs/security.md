# Security and threat model

RuleDeck holds credentials that can rewrite a firewall. Treat the RuleDeck host as being as sensitive as the firewall itself.

## Assets

| Asset | Why it matters |
|---|---|
| OPNsense API key/secret | Full control over firewall policy (and more, depending on privileges) |
| RuleDeck session cookie | Lets the holder stage and apply changes |
| Firewall configuration | Wrong rules can expose networks or lock admins out |
| Audit log | Accountability. Must not contain secrets |

## Trust boundaries

1. Browser ⇄ RuleDeck server: untrusted client. Every input is validated (zod) and every state-changing request must carry a valid session and CSRF token.
2. RuleDeck server ⇄ OPNsense: the server is the only component that holds the API secret. Responses from OPNsense are validated before use.

## Threats and mitigations

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | API secret leaks to browser | Secret is only read from env on the server. No endpoint returns it. Errors from the HTTP client are mapped to sanitized messages. Logger redacts `authorization` | Phase 1 |
| T2 | Secret in logs/audit | Fastify logger redaction. Audit events store user, action, object ids, outcome only | Phase 1 / 4 |
| T3 | MITM between RuleDeck and OPNsense | TLS verification is always on. Self-signed firewalls use `OPNSENSE_CA_FILE`. Plain HTTP is only accepted for loopback hosts (the mock). **There is no "insecure" switch** | Phase 1 |
| T4 | SSRF via firewall URL | Firewall endpoints are defined by the operator (env/config), not by browser requests. The client only builds paths from a fixed list of `module/controller/command` constants. Path params are validated (uuid / alias-name patterns) and URL-encoded | Phase 1 |
| T5 | Unauthorized UI access | Login required for all `/api/*` except `/api/auth/login` and `/api/health`. Password compared against a scrypt hash with timing-safe compare | Phase 1 |
| T6 | Session theft | Random 256-bit session id, `HttpOnly`, `SameSite=Strict`, `Secure` when served over HTTPS, idle timeout 30 min, absolute timeout 12 h | Phase 1 |
| T7 | CSRF | `SameSite=Strict` plus a per-session CSRF token required in `X-CSRF-Token` on every non-GET request | Phase 1 |
| T8 | Brute force login | Per-IP rate limit on login (5/min) | Phase 1 |
| T9 | Accidental destructive change | Changes are staged locally. Apply needs explicit confirmation on a review screen. Deleting a referenced alias requires acknowledging the impact | Phase 3/4 |
| T10 | Admin lockout | Review screen flags risky changes: block/reject rules on the management interface, disabling or deleting pass rules that reach `(self)`, changes to the anti-lockout area. Where the firewall supports it (26.1), apply uses the rollback timer | Phase 4 |
| T11 | Silent overwrite of someone else's change | Fingerprint-based conflict detection before apply. On conflict nothing is written | Phase 4 |
| T12 | Public exposure | Compose binds to `127.0.0.1` only. Docs explain how to put it behind a reverse proxy with TLS | Phase 5 |
| T13 | Stored credentials theft (DB copy) | Credentials added via UI (Phase 5) are encrypted with AES-256-GCM. The key comes from `RULEDECK_MASTER_KEY` (env/secret manager), never stored next to the DB | Phase 5 |

## OPNsense API user — minimum privileges

Create a dedicated user in OPNsense (System ▸ Access ▸ Users) with an API key and only these privileges:

- `Firewall: Rules [new]` (firewall/filter)
- `Firewall: Alias: Edit` (firewall/alias)
- `System: Firmware` *read* is needed for version detection. If you prefer not to grant it, set `OPNSENSE_VERSION` manually
- `Diagnostics: Configuration History` (only if you want RuleDeck to list config history for recovery)

The exact privilege names differ slightly between releases. This list is verified once the live tests run.

## Configuration

| Env var | Meaning |
|---|---|
| `RULEDECK_ADMIN_USER` | Login name (default `admin`) |
| `RULEDECK_ADMIN_PASSWORD_HASH` | `scrypt$<salt-b64>$<hash-b64>`. Generate with `npm run hash-password` |
| `OPNSENSE_URL` | e.g. `https://fw.lan` |
| `OPNSENSE_API_KEY` / `OPNSENSE_API_SECRET` | API credentials |
| `OPNSENSE_CA_FILE` | Optional PEM bundle for a self-signed firewall certificate |

Example files contain placeholders only.
