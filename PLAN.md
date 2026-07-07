# Photo Showcase — Project Plan

> Personal photography portfolio + private client gallery delivery.
> Domain: **alejoframes.com** (apex — the photography brand). Sibling project `findash` lives on `findash.alejoframes.com`.

---

## 1. What this is

Two products living under one codebase, sharing infrastructure but serving different audiences:

| Product                      | Audience       | Nature                                                                      |
| ---------------------------- | -------------- | --------------------------------------------------------------------------- |
| **Public portfolio**         | Anyone (SEO)   | Curated showcase of the photographer's own work. Read-only, public.         |
| **Private gallery delivery** | Paying clients | Pixieset-style flow: proofing → selection → editing → delivery. Auth-gated. |

The portfolio is the simple, high-value product. The gallery delivery is where the real complexity lives (state machine, auth, media pipeline).

---

## 2. Domain model — the gallery is a state machine

A gallery is **not** a folder of photos. It is a workflow that advances through states. This drives the entire data model.

```
DRAFT ──▶ PROOFING ──▶ SELECTED ──▶ DELIVERED  (──▶ ARCHIVED, future)
  │           │            │             │
  │           │            │             └─ Client views & downloads final edits freely.
  │           │            └─ Photographer edits selected photos, uploads finals, delivers.
  │           └─ Client browses low-res watermarked proofs, picks which to edit, submits.
  └─ Photographer uploads proofs (auto watermark + downscale). Not yet visible to client.
```

### Each photo is one asset with two representations

We never model "a photo." We model an **asset** that carries:

- **proof** — low resolution + watermark, protection copy. Exists for every asset from the start.
- **final** — full resolution, no watermark, downloadable. Exists **only** for selected assets, after editing.
- **selection state** — whether the client picked this asset for editing.

The heavy RAW files stay on the photographer's PC and never enter the system.

---

## 3. Business rules — packages & quotas

Every gallery is created bound to a **package**. The package defines the included edited-photo quota (a hard ceiling, not the fuzzy human range).

| Package  | Price (COP) | Session | Included edits | Surcharge starts at |
| -------- | ----------- | ------- | -------------- | ------------------- |
| Básico   | $60,000     | 1 h     | **7**          | photo #8            |
| Estándar | $100,000    | 1.5–2 h | **13**         | photo #14           |
| Premium  | $180,000    | 2–3 h   | **20**         | photo #21           |

- **Extra photo:** $5,000 COP each.
- **The app never charges money.** During selection it shows a live counter and the surcharge total; payment for extras is settled outside the app (WhatsApp / transfer).

```
Estándar · included: 13
Selected: 15
Extras: 2 × $5,000 = $10,000 COP   ← displayed, not charged
```

**Why no payment gateway:** the client pays for the photographer's _time_; the photos are the guaranteed minimum. Removing in-app payment cuts the project in half — no gateway, no webhooks, no PCI — and loses nothing the business needs.

---

## 4. Authentication — passwordless, admin-provisioned

- **Single admin** (the photographer). No client self-registration.
- Admin **creates the client** (name + email). The email _is_ the identity.
- Client logs in via **magic link sent to that email**. No passwords to remember, reset, or leak.
- Because identity = email, a client sees **all their historical galleries** in one place — the benefit of accounts without the friction of registration.

**Security invariants (non-negotiable at implementation time):**

- Magic-link tokens are **single-use** and **short-lived** (~15–30 min).
- Session established via httpOnly, secure cookie after the link is clicked.
- Every resolver / route verifies the session owns the gallery being accessed.

Built on **NextAuth v5** (already in the sibling project) with a magic-link email provider + Drizzle adapter. Email delivery via **Resend**.

---

## 5. Media pipeline

Powered by **`sharp`** (already a trusted dependency in findash). Low volume → **process inline on upload; no queue/Redis needed** for this app.

**Proof upload (photographer → system):**

1. Photographer uploads proof images (exported from Lightroom, RAWs stay on PC).
2. `sharp` resizes to a max long edge (~1600px), applies the **watermark overlay**, strips EXIF, outputs WebP.
3. Stored in R2 at `galleries/{galleryId}/proofs/{assetId}.webp`.

Automatic watermarking is a deliberate choice: the system guarantees protection, the photographer can never forget it.

**Final upload (after editing):**

1. Photographer uploads edited full-quality images for selected assets only.
2. `sharp` strips EXIF, outputs optimized full-res JPEG (no watermark).
3. Stored in R2 at `galleries/{galleryId}/finals/{assetId}.jpg`.

**Serving:** R2 objects are **private**. The app issues **short-lived presigned URLs** after verifying the client's session owns the gallery. Cloudflare fronts R2 → free egress + CDN. The droplet never streams image bytes.

**File uploads themselves go through small REST route handlers that hand out presigned upload URLs — NOT through GraphQL** (multipart uploads over GraphQL are painful and not worth it).

### Why R2 and not the droplet's 80 GB disk

Considered and rejected. Reasoning:

- **Cost is a non-issue.** At ~6.5 GB/year, R2's 10 GB free tier covers the first ~1.5 years at **$0**, then cents (~$0.33/mo at year 5, ~$0.83/mo at year 10). Egress is always free. DigitalOcean Spaces (the all-DO analog) starts at a flat $5/mo — _more_ than R2 at this scale.
- **Durability is the real reason.** Client photos are irreplaceable professional deliverables. A single droplet disk is a single point of failure (hardware fault, bad rebuild, stray `rm`). Losing a client's wedding gallery is business-ending.
- **You'd need object storage anyway** — those files must be backed up off the droplet, so droplet-disk storage doesn't remove R2, it just adds a fragile primary copy.
- **Serving full-res from the droplet** burns its CPU/transfer and competes with the app; R2 behind Cloudflare offloads it entirely (droplet streams zero image bytes).
- **Deploy safety:** the release-dir + rollback deploy model would require media to live outside the release dir; R2 sidesteps this.
- **Already configured** for findash backups — no new vendor.

---

## 6. Data model (Postgres + Drizzle)

```
clients            packages              galleries                assets
─────────          ─────────             ─────────                ──────
id                 id                    id                       id
name               name                  client_id   ──▶ clients  gallery_id ──▶ galleries
email  (unique)    price_cop             package_id  ──▶ packages  original_filename
created_at         included_photos       title                    proof_key   (R2)
                   extra_photo_price_cop  session_date             final_key   (R2, nullable)
                   duration_label         status (enum)            is_selected (bool)
                                          created_at               selected_at (nullable)
                                          delivered_at             is_edited   (bool)
                                          public_slug              sort_order
```

- `galleries.status`: `draft | proofing | selected | delivered | archived`.
- **Selection count is derived**, not stored: `selected = count(assets where is_selected)`, `extras = max(0, selected − package.included_photos)`, `surcharge = extras × package.extra_photo_price_cop`.
- `packages` is a seeded table (not an enum) so prices/quotas are editable without a migration.
- NextAuth's own tables (users, sessions, verification tokens) handled by its Drizzle adapter. Admin is a user row with `role = admin`.

**Portfolio content** (public work) is a separate, simpler concern — either a `portfolio_items` table or file/CMS-driven. Decided in Phase 1.

---

## 7. GraphQL layer (learning goal)

> **Honest framing:** for ~6 entities, one admin, and clients who browse/select, GraphQL is _not_ technically required — Server Actions or a small REST would suffice. It is included deliberately as a **learning driver** in a low-risk, well-understood sandbox. That is a legitimate reason. We keep it honest: learning, not necessity.

- **Server:** GraphQL Yoga mounted on a Next route handler — `app/api/graphql/route.ts`.
- **Schema:** Pothos (code-first, type-safe) — pairs cleanly with Drizzle + TypeScript.
- **Client:** Apollo Client (what the job market uses) + `graphql-codegen` for typed hooks.
- **Auth context:** NextAuth session injected into the Yoga context; resolvers enforce gallery ownership.
- **Scope:** GraphQL covers **data reads + state mutations**. Binary uploads stay on REST/presigned-URL routes.

Built into the app data layer **from the start of Phase 2** (greenfield) — not a later migration. Don't build the data layer twice.

---

## 8. Tech stack — reuse `findash`, don't reinvent

| Concern                   | Choice                                                      | Source                 |
| ------------------------- | ----------------------------------------------------------- | ---------------------- |
| Runtime / package manager | Bun                                                         | reuse                  |
| Framework                 | Next.js 16 (App Router, `output: standalone`)               | reuse                  |
| UI                        | React 19 + Tailwind 4 + shadcn/ui + Radix + lucide + sonner | reuse                  |
| Database                  | Postgres 17 (peer auth, unix socket) + Drizzle ORM          | new DB `photoshowcase` |
| Auth                      | NextAuth v5 + jose, magic-link email provider               | reuse pattern          |
| Email                     | Resend                                                      | **new dependency**     |
| Images                    | `sharp` (watermark + resize)                                | reuse                  |
| API (learning)            | GraphQL Yoga + Pothos + Apollo Client                       | **new**                |
| Validation                | Zod                                                         | reuse                  |
| Testing                   | Vitest + Playwright                                         | reuse                  |
| Lint / format / hooks     | eslint + prettier + husky + lint-staged                     | reuse                  |

---

## 9. Deployment — delta on the existing droplet

**Start on the current droplet as-is (2 vCPU / 2 GB / 60 GB NVMe, $21/mo).** The resize to 4 GB ($28/mo) is **deferred** until RAM actually justifies it — no paying for capacity before it's needed. Early phases (portfolio only) are light and fit the 2 GB comfortably; RAM pressure only appears in Phase 2/3 when both apps run in full. Mitigations while on 2 GB: photo-showcase processes images **inline** (no Redis/BullMQ), caps its memory (`max_memory_restart`), and RAM is monitored. Resize when the numbers say so.

Photos live in R2, not on droplet disk. Existing topology (Cloudflare → Caddy → Next standalone → Postgres) is replicated for a second site.

**Changes to make:**

1. **DNS (Cloudflare):** point `alejoframes.com` apex (+ `www` redirect) at the droplet IP, proxied.
2. **Cloudflare origin cert:** issue a cert covering the apex `alejoframes.com` (the current one is scoped to the findash subdomain) — or a wildcard.
3. **Caddy:** add a site block for `alejoframes.com` → `reverse_proxy localhost:3200`, TLS via origin cert.
4. **systemd:** `photoshowcase.service` on port 3200 with its own EnvironmentFile.
5. **Postgres:** create DB `photoshowcase` + role `photoshowcase` (peer auth); run Drizzle migrations.
6. **R2:** new bucket (or prefix) for gallery media, private, served via presigned URLs behind Cloudflare.
7. **CD:** replicate the GitHub Actions deploy workflow (standalone build → rsync → release dir → rollback).
8. **Backups:** extend the existing R2 backup script to include the `photoshowcase` DB.

---

## 10. Phased roadmap

**Phase 0 — Foundations & deploy skeleton**
Scaffold Next 16 + Bun + Tailwind + shadcn (copy configs from findash). Drizzle + Postgres DB. Get a "hello world" live on `alejoframes.com` early (DNS, cert, Caddy, systemd, CD). _Deploy early, deploy often._

**Phase 1 — Public portfolio**
Portfolio pages (home, collections, about, contact). Curated public work via `next/image`. Ship the simple product first — immediate value + SEO. No GraphQL here.

**Phase 2 — Auth + data model + GraphQL core**
NextAuth magic-link + admin role + Resend. Schema: clients, packages, galleries, assets. GraphQL (Yoga + Pothos + Apollo) as the data layer from day one. Admin: create client, create gallery (pick package), upload proofs (sharp watermark pipeline), publish. Client: magic-link login, browse proofs.

**Phase 3 — Selection & delivery flow**
Client selection UI with the live counter (included / extras / surcharge). Submit selection → lock + state transition + notify admin. Admin uploads finals for selected assets, delivers → notify client. Client views & downloads finals.

**Phase 4 — Polish**
Email templates, download-all (zip), gallery expiry/archival, favorites, basic analytics, backup coverage.

---

## 11. Open questions / future

- Portfolio content source: DB table vs. file-based vs. lightweight CMS (decide in Phase 1).
- Gallery expiry / archival policy (galleries live forever for now; revisit later).
- Download-all as zip — build on droplet or via a Cloudflare Worker?
- Watermark design (logo, opacity, tiling) — needs the actual brand asset.
