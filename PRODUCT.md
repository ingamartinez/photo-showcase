# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three audiences, confirmed to weigh equally. None outranks the others.

- **The photographer (admin)** — single operator running a studio: creates clients, builds galleries bound to a package, uploads proofs, reviews selections, uploads finals, delivers. Works from a laptop in the studio.
- **The client** — a paying customer receiving a session's photos: signs in via magic link, browses watermarked proofs, selects which assets to have edited, later downloads finals. Typically on a phone.
- **The public visitor** — anyone discovering the photographer's work via search or a link: browses the portfolio, collections, and contact path.

## Product Purpose

A photography studio's working surface: a curated public portfolio that generates leads, plus a private gallery-delivery workflow that takes a client session from proofing to selection to editing to delivery.

**The body of work is predominantly cosplay photography.** Confirmed: the product should lead with that, while staying open to other categories (the portfolio already spans non-cosplay collections). Success means the photographer can run a real session end to end, the client can complete selection and download on a phone without friction, and the public site presents the cosplay work well enough to earn an inquiry.

## Positioning

Four confirmed mechanisms, jointly held. A generic gallery SaaS could not truthfully copy the combination:

1. **Delivery without in-app payment.** Proof → select → edit → deliver, with the package quota and any surcharge always visible, while payment itself is settled outside the app (WhatsApp / transfer). No payment gateway, ever.
2. **The photographer's personal practice.** The product is the extension of one named photographer — Alejo Frames — with his own voice and judgment, not a white-label gallery platform.
3. **The photograph leads; the interface recedes.** The value is the work and how it is presented. Software must stay out of the way.
4. **Quota and extras are never hidden.** Included edits, current selection count, and any surcharge in COP stay legible in every relevant state.

## Operating Context

- One photographer as sole admin; clients are provisioned by the admin (email is identity). No client self-registration.
- Gallery lifecycle is a state machine: `draft → proofing → selected → delivered` (archived later).
- Proofs are auto-watermarked and downscaled on upload; finals exist only for selected assets.
- Clients commonly arrive from a phone (messaging apps, email links). Selection, gallery browsing, and downloads are the mobile-critical paths.
- External UI libraries and third-party components are in scope for usability: anything brought in must serve the mobile-critical paths, not degrade them.

## Capabilities and Constraints

- Public portfolio: home, collections, work index, work detail, about, contact.
- Admin dashboard: clients, galleries, gallery workspace (proof upload, selection review, finals upload, deliver).
- Client gallery: gallery index, gallery detail with proof grid and selection tray, submit selection, download finals / download-all.
- Auth: passwordless magic link (NextAuth v5 + Resend). Session is httpOnly/secure cookie. Tokens single-use and short-lived.
- Media: `sharp` inline (no queue). Proofs WebP ~1600px long edge + watermark. Finals full-res JPEG, EXIF stripped. Storage in private R2, served via short-lived presigned URLs after ownership checks.
- Packages are a seeded table (Básico 7 / Estándar 13 / Premium 20 included edits) with extra-photo pricing. The app never charges money.
- GraphQL (Yoga + Pothos) covers data reads and state mutations only. Binaries and presigned URLs never traverse GraphQL.
- Selection sync across viewers uses short-interval polling (5s, tab-visible only). The tray can be up to 5 seconds stale — accepted.
- **Copy language is neutral Spanish.** Confirmed decision: no rioplatense voseo. The current codebase still contains voseo strings (`cargás`, `armás`, `podés`, `tenés`, …) and must be migrated to neutral Spanish as part of this redesign. English is used for technical artifacts, not UI copy.
- **Mobile-first is a hard constraint**, especially for galleries, selection, and downloads. Usability (UX and UI) is judged on a phone first.

## Brand Commitments

- **Name:** Alejo Frames.
- **Domain:** alejoframes.com (apex).
- **Voice:** direct, warm, professional neutral Spanish. No voseo, no regional slang in UI copy.
- The photographer's identity is the brand. The product must read as his practice, not as a generic platform.
- **Subject matter: predominantly cosplay.** The interface must be able to honor that world specifically, without hard-coding cosplay so tightly that other categories feel like a bolt-on.

## Evidence on Hand

- `PLAN.md` — product reasoning, domain model, business rules, deployment shape. Background authority; the board and this file win on conflicts.
- Live implementation under `src/app` (`(marketing)`, `dashboard`, `galleries`) with components in `src/components`.
- Portfolio content manifest: `src/content/portfolio.ts`, images under `public/portfolio/`. **Current images are Instagram web-preview crops, placeholders only.** Proper high-res exports are not on hand and must not be assumed. No model-release-cleared final assets yet.
- Previous visual direction: `design/system/dashboard.html`, `design/system/client.html`, `design/system/home.html`. For this redesign they are evidence and anti-reference, not authority.
- Seeded packages and the business-rule copy they carry.
- No testimonials, press, case studies, or client quotes exist. Future work must not fabricate them.

## Product Principles

1. Three audiences weigh equally; no surface is second-class.
2. The photograph leads; the interface recedes.
3. Commercial terms — quota, extras, surcharge — are never hidden.
4. The product never charges money; payment is settled outside it.
5. Accessibility and mobile usability are release conditions, not polish.

## Accessibility & Inclusion

- Accessibility is a confirmed acceptance requirement, not an aspiration. Target a concrete standard (WCAG 2.2 AA) for new interface work.
- Mobile usability is part of the same bar: touch targets, legibility, selection and download flows must work on a phone first.
- Alt text is required on portfolio assets (already enforced by the content manifest).
