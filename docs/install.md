# Installing and running RuleDeck

RuleDeck is one small server (Node.js) that also serves the web app. It stores nothing: no database, no volume, no credentials. Everything it knows comes from two files you write once (an env file and a topology file) and from the firewalls themselves.

## 1. What you need

- A machine on your **management network** that can reach the firewalls' web GUI (HTTPS) — a small VM or container host is enough.
- Docker with Compose (recommended), or Node.js 22.13+.
- OPNsense **26.1 or 26.7** (reads work on 25.7; editing needs 26.1+). Reads were verified on 26.7.
- For more than a few users or access from other machines: a TLS reverse proxy (examples below).

Never expose RuleDeck to the internet.

## 2. Prepare OPNsense

**Users.** Everyone signs in with their own OPNsense account, so the config history shows who changed what. LDAP, RADIUS and TOTP work as they do in the OPNsense GUI. Give each user only the privileges they need ([docs/security.md](security.md#opnsense-users-and-privileges) lists them per feature). RuleDeck can never do more than the signed-in user.

**API keys (optional).** Instead of a password, a user can sign in with an API key (System ▸ Access ▸ Users ▸ API keys). A read-only key is a good way to try RuleDeck safely.

**HA pairs.** RuleDeck writes only to the **primary** (the node that synchronizes to its peer) and checks that before every shared apply. Configure HA sync (System ▸ High Availability) as usual.

**DNS rebind protection.** If you reach the firewall by a hostname, add it under System ▸ Settings ▸ Administration ▸ *Alternate Hostnames*, or use the IP address.

## 3. The topology file

`ruledeck.topology.json` lists your sites. It contains **no secrets** and is mounted read-only. Start from `ruledeck.topology.example.json`:

```json
{
  "version": 1,
  "sites": [
    {
      "id": "ber",
      "name": "Berlin",
      "primary":   { "url": "https://10.1.0.2", "tlsFingerprint": "AB:CD:…" },
      "secondary": { "url": "https://10.1.0.3" },
      "interfaces": {
        "WAN": { "key": "wan",  "label": "WAN" },
        "DMZ": { "key": "opt1", "label": "DMZ" }
      }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Short id: lowercase letters, digits, dashes |
| `name` | Shown in the UI |
| `primary.url` | The HA primary's GUI address. HTTPS only, no path |
| `secondary.url` | The HA peer (optional; marks the site as an HA pair) |
| `tlsFingerprint` | **Pin** the firewall's certificate (self-signed GUI certificates). Get it with `npm run fingerprint -- 10.1.0.2` and compare it with System ▸ Trust ▸ Certificates on the firewall before trusting it |
| `caFile` | Alternatively, a private CA (PEM) that signed the GUI certificate. With neither, the certificate must be publicly trusted. TLS verification can't be switched off |
| `interfaces` | Only for the shared policy across sites: maps logical names to each site's interfaces. All sites or none; see [multi-site.md](multi-site.md#the-interface-map-topology-file) |
| `timeoutMs` | Request timeout for this site (default 15000) |

RuleDeck refuses to start with a clear message if the file is invalid.

## 4. Settings (`apps/server/.env`)

Copy `.env.example`. None of these are secret.

| Setting | Default | Meaning |
|---|---|---|
| `RULEDECK_TOPOLOGY_FILE` | `./ruledeck.topology.json` | Where the topology file is |
| `RULEDECK_ALLOW_WRITES` | `false` | Master switch for sending changes to firewalls. Leave `false` until you've tried RuleDeck on a lab |
| `RULEDECK_HOST` / `RULEDECK_PORT` | `127.0.0.1` / `3000` | Where the server listens |
| `RULEDECK_COOKIE_SECURE` | `true` in production | Session cookie only over HTTPS. Browsers also accept it on `http://localhost` / `127.0.0.1` |
| `RULEDECK_TRUST_PROXY` | `false` | `true` behind a reverse proxy that **overwrites** `X-Forwarded-For` |
| `RULEDECK_APPLY_RATE_LIMIT` | `10` | Applies per user per minute |
| `RULEDECK_SITE_LOGIN_FAILURES` | `4` | Failed password sign-ins per site per hour through RuleDeck (keeps RuleDeck's address out of OPNsense's login lockout, which triggers at 5) |

## 5. Run it with Docker Compose

```sh
git clone https://github.com/famyfa/ruledesk.git && cd ruledesk
cp .env.example apps/server/.env
cp ruledeck.topology.example.json ruledeck.topology.json
# edit both files
docker compose up -d --build
docker compose logs -f        # "Topology: Berlin, Munich (writes disabled)" means it's ready
```

Open http://127.0.0.1:3000 on that machine. The container listens on localhost only, runs as a non-root user with a read-only filesystem and no capabilities, and has no volume (the topology file and an optional `./certs` folder are mounted read-only).

### Without Docker

```sh
npm ci
npm run build
cd apps/server && NODE_ENV=production RULEDECK_WEB_DIST=../web/dist npm start
```

Relative paths in `apps/server/.env` (e.g. `RULEDECK_TOPOLOGY_FILE`) are relative to `apps/server`; use an absolute path to be safe. Run it as an unprivileged user, e.g. with a systemd unit.

## 6. A reverse proxy for access from other machines

Put RuleDeck behind TLS and keep it on the management network. Set `RULEDECK_TRUST_PROXY=true` and keep `RULEDECK_HOST=127.0.0.1` when the proxy runs on the same host.

**Caddy**

```
ruledeck.mgmt.example {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx**

```nginx
server {
    listen 443 ssl;
    server_name ruledeck.mgmt.example;
    ssl_certificate     /etc/ssl/ruledeck.crt;
    ssl_certificate_key /etc/ssl/ruledeck.key;
    client_max_body_size 32m;              # large rule sets are sent when applying
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, don't append
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;           # applying to several sites can take a while
    }
}
```

## 7. First steps

1. Sign in. Use the same account for all sites, or different ones per site (and API keys if you like). The Sites tab shows who you are on each firewall and its version.
2. Look around with writes **off**: Policies, Objects, Services, Monitor, Global ▸ Rules/Aliases all sites.
3. On a lab firewall, set `RULEDECK_ALLOW_WRITES=true`, restart, and make one small change (e.g. switch logging on for a rule). Review, apply, check the firewall's config history.
4. For several sites: add the interface map, then try Global ▸ Shared rules with a disabled test rule first ([multi-site.md](multi-site.md)).

## 8. Upgrading

```sh
git pull
docker compose up -d --build
```

Nothing to migrate: RuleDeck has no state. Signed-in users have to sign in again; staged changes in their browser tab come back after signing in.

## 9. If something goes wrong

RuleDeck has **no automatic rollback**. Every apply shows exactly what was written. To undo, restore the previous revision in OPNsense under **System ▸ Configuration ▸ History** (each RuleDeck write creates one, under the signed-in user's name).

| Message | What to do |
|---|---|
| *certificate fingerprint … doesn't match the pinned one* | The GUI certificate changed. If you renewed it, update `tlsFingerprint`; otherwise someone may be intercepting the connection |
| *TLS certificate could not be verified* | Pin it with `tlsFingerprint` or add its CA as `caFile` |
| *DNS-rebind protection* | Use the IP address or add the hostname to Alternate Hostnames |
| *Too many failed sign-ins … in the last hour* | Protects RuleDeck's address from OPNsense's lockout. Wait, or sign in with an API key |
| *Sending changes to firewalls is disabled* | `RULEDECK_ALLOW_WRITES=true`, then restart |
| *Your OPNsense user lacks the privilege for …* | Give the user that page's privilege in OPNsense |
| *Your session on this firewall ended* | Sign in again (the firewall's own session timeout applies) |
| *The topology file has no interface map* | Shared policy needs `interfaces` in the topology ([multi-site.md](multi-site.md)) |
| A site is *blocked* in Apply to all sites | The reason is shown per site: not signed in, conflict, interface map mismatch, not the HA primary, … Nothing was written anywhere |
