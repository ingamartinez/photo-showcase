# infra/

Droplet-side scaffolding for deploying photo-showcase as a **second site** on
the existing DigitalOcean droplet that already runs findash. The CD workflow
(`.github/workflows/deploy.yml`) automates the per-release steps; everything in
this README is one-time host setup **you run by SSH**.

## Files

| Path                            | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `systemd/photoshowcase.service` | systemd unit for the Next.js standalone process (port 3300).       |
| `caddy/Caddyfile`               | Reverse-proxy block for `alejoframes.com` (apex) + `www` redirect. |

## One-time droplet bring-up

Run as a sudo-capable user on the droplet. `$USER_NAME` = `photoshowcase`.

### 1. Service user + directory layout

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin photoshowcase
sudo install -d -o photoshowcase -g photoshowcase -m 0755 \
  /srv/photoshowcase/app/releases \
  /srv/photoshowcase/env \
  /srv/photoshowcase/logs
```

### 2. Postgres DB + role (peer auth)

```bash
sudo -u postgres createuser photoshowcase          # peer-auth role, no password
sudo -u postgres createdb  -O photoshowcase photoshowcase
```

The app connects over the unix socket as the `photoshowcase` OS user → peer
auth, no password in the env file. Matches `src/lib/db/index.ts`.

### 3. Runtime env file

```bash
sudo -u photoshowcase tee /srv/photoshowcase/env/photoshowcase.env >/dev/null <<'EOF'
PGDATABASE=photoshowcase
# Phase 2+: AUTH_SECRET, RESEND_API_KEY, R2_* — added when those features land.
EOF
sudo chmod 0640 /srv/photoshowcase/env/photoshowcase.env
```

### 4. systemd unit

```bash
sudo cp infra/systemd/photoshowcase.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable photoshowcase.service   # starts after first CD deploy
```

### 5. Caddy site block

Caddy already fronts findash on this droplet. Add this site to the same Caddy:

```bash
# If /etc/caddy/Caddyfile uses `import sites/*`, drop the block in as a file:
sudo cp infra/caddy/Caddyfile /etc/caddy/sites/photoshowcase.caddy
# Otherwise append its contents to /etc/caddy/Caddyfile.
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 6. Cloudflare origin cert (apex)

The findash cert is scoped to its subdomain and does **not** cover the apex.
Issue a Cloudflare origin cert that includes `alejoframes.com` (and
`www.alejoframes.com`), then:

```bash
sudo install -m 0644 alejoframes-origin.pem /etc/caddy/alejoframes-origin.pem
sudo install -m 0640 -g caddy alejoframes-origin.key /etc/caddy/alejoframes-origin.key
sudo systemctl reload caddy
```

### 7. DNS (Cloudflare dashboard)

- `alejoframes.com` (apex) → droplet IP, **proxied** (orange cloud).
- `www.alejoframes.com` → droplet IP, proxied (Caddy redirects it to the apex).
- SSL/TLS mode: **Full (strict)**.

## GitHub Actions secrets (repo settings)

The deploy workflow needs these repo secrets:

| Secret           | Value                                                       |
| ---------------- | ----------------------------------------------------------- |
| `DEPLOY_HOST`    | droplet IP (`147.182.138.79`)                               |
| `DEPLOY_USER`    | `deploy` (low-priv CD user, narrow sudo)                    |
| `DEPLOY_SSH_KEY` | private key authorized for `deploy` (dedicated, not root's) |

The deploy workflow health-probes `http://127.0.0.1:3300/api/health` on the
droplet over SSH, so it does not need a public URL and works before Cloudflare
DNS + the apex origin cert are in place.

## First deploy

Push to `main` (or run the **Deploy** workflow manually). On success:

```bash
curl https://alejoframes.com/api/health   # expect {"ok":true,...,"db":"ok"}
```

## Media storage (R2) — Phase 2

Gallery media lives in a private Cloudflare R2 bucket served via presigned URLs
(see PLAN.md §5). Provision the bucket + credentials when Phase 2 lands; nothing
to do at Phase 0.
