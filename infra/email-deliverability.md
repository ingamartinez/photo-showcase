# Email deliverability — SPF, DKIM, DMARC

Outbound mail for `alejoframes.com` goes through **Resend**, which transports
over **Amazon SES**. This file records what is published in DNS, why each record
is where it is, and — more importantly — **why one record that looks missing is
deliberately absent**.

Everything here was verified against the Cloudflare API and against the public
resolvers `1.1.1.1`, `8.8.8.8` and `9.9.9.9` on 2026-07-31 (task #152). None of
it is inferred from a vendor dashboard screenshot.

Where something was **not** measured, it says so in place. Take those caveats
literally: this file is written to be trusted, so the boundary between "checked"
and "assumed" is the most load-bearing thing in it.

## The zone is shared with findash — read this first

`alejoframes.com` is a **single Cloudflare zone** that also contains
`findash.alejoframes.com`. findash is not a separate domain with its own DNS;
it is a subdomain of this one. Every warning below about "do not break the other
project" is literal, not precautionary.

Zone id: `69b246d6d3c8d1c4d38f45d9a7198fe5`, plan Free — both read from the
Cloudflare API on 2026-07-31.

## What is published

| Name                                | Type | Value                                                         |
| ----------------------------------- | ---- | ------------------------------------------------------------- |
| `resend._domainkey.alejoframes.com` | TXT  | `p=MIGfMA0GCSqG…` (RSA public key, selector `resend`)         |
| `send.alejoframes.com`              | TXT  | `v=spf1 include:amazonses.com ~all`                           |
| `send.alejoframes.com`              | MX   | `10 feedback-smtp.us-east-1.amazonses.com`                    |
| `_dmarc.alejoframes.com`            | TXT  | `v=DMARC1; p=none; rua=mailto:…@dmarc-reports.cloudflare.net` |

The Resend domain `alejoframes.com` is in `verified` status, region `us-east-1`.

`EMAIL_FROM` is `no-reply@alejoframes.com` — the **apex**, not `send.` — with no
display name and no angle brackets. Read on 2026-07-31 from the deployed
`/srv/photoshowcase/env/photoshowcase.env` over SSH, not from `.env.example`,
and independently confirmed by the `From:` header of a real production email.

**`infra/cron/README.md` and `infra/cron/photoshowcase-backup.sh` used to state
this value as `Alejo Frames <hi@alejoframes.com>`, and that was stale** — see
the note now in those files. Their argument (never source a systemd
`EnvironmentFile` as shell) is unaffected and still correct; only the worked
example was wrong.

## Why there is no SPF record at the apex, and why adding one is a mistake

This is the counterintuitive part, and it is the reason this file exists. Every
guide says "add an SPF record for your domain", the apex has no `v=spf1`, and
the obvious conclusion — that something is missing — is wrong.

**SPF authenticates the envelope sender (the `MAIL FROM` / `Return-Path`), not
the `From:` header the recipient sees.** Resend sets the envelope to a
per-message address at `send.alejoframes.com`, so that is the domain a receiver
looks up SPF for. It is published there and it passes. From the headers of the
2026-07-31 verification delivery — the same message as the "after" block below:

```
Return-Path: <0100019fb9dcb2d5-…-000000@send.alejoframes.com>
Received-SPF: pass (google.com: domain of …@send.alejoframes.com
              designates 54.240.14.40 as permitted sender)
```

(`54.240.14.40` falls inside `54.240.0.0/18`, which `amazonses.com`'s own SPF
publishes — consistent with the transport this file describes.)

An apex `v=spf1` would not be consulted for these messages at all. Be precise
about which apex record is a mistake: **a permissive one duplicating Resend's**
(`v=spf1 include:amazonses.com ~all`) buys nothing here and carries two real
risks.

1. **A domain must have exactly one SPF record.** Publishing a second one — for
   example because someone later "adds SPF for Resend" without noticing an
   existing record — makes SPF evaluation return `permerror` and **both**
   records stop working. This is the classic way a working setup gets broken by
   a well-intentioned fix.
2. **findash lives in this zone.** An apex change is not scoped to this project.
   Note the limit of that risk, because it is easy to overstate: **SPF does not
   descend to subdomains**, so mail with an envelope at
   `@findash.alejoframes.com` would be unaffected by an apex record either way.
   The exposure is specifically anything sending with an envelope at the **apex
   itself**. Whether findash does is **not verified here** — as of 2026-07-31
   `findash.alejoframes.com` publishes no MX and no TXT, only proxied A records,
   and nothing in this repo shows it sending mail at all. Confirm before
   assuming either way.

The one apex record that would _not_ be inert is `v=spf1 -all`, which is
standard hardening for a domain that never sends: it tells receivers to reject
anything forging an apex envelope. That is a real, separate improvement rather
than a duplicate — but it is only safe once risk 2 above is actually verified,
because it breaks any apex sender that turns out to exist.

If a future change makes the app send with an apex envelope (a different
provider, or Resend without a custom return-path), then a permissive apex SPF
becomes correct — but that is a change to make deliberately, after confirming
the `Return-Path` actually moved, not a gap to fill preemptively.

## DMARC alignment: both channels align independently

DMARC does not just ask "did SPF and DKIM pass?" — it asks whether either one
passed **for a domain that aligns with the `From:` header**. Here, both do:

- **DKIM** — the message carries _two_ signatures. One is `d=amazonses.com`
  (the transport's own) and does **not** align. The one that matters is
  `d=alejoframes.com`, selector `resend`, which does. Without that second
  signature the DKIM channel would not align at all — DMARC would still pass
  on aligned SPF alone, but with no redundancy left.
- **SPF** — the envelope domain `send.alejoframes.com` is a subdomain of the
  organizational domain `alejoframes.com`, which matches `header.from`. Under
  DMARC's default relaxed alignment, that aligns.

So the setup passes twice over. If one channel breaks later, `dmarc=pass`
survives on the other — and the aggregate reports will show which one went
quiet, instead of the whole thing failing at once.

## DMARC reports and the RFC 7489 §7.1 trap

Reports go to a Cloudflare-managed mailbox via **DMARC Management**, enabled
from the Cloudflare dashboard. There is no API endpoint to enable it; it is a
panel action.

The trap that ruled out the obvious alternatives: **if the `rua` address is at a
different domain than the DMARC record itself, the receiving domain must publish
an authorization record**, or compliant reporters silently send nothing. The
record has the form
`<policy-domain>._report._dmarc.<external-domain>`. Cloudflare publishes it, and
it is verified present:

```
$ dig +short TXT alejoframes.com._report._dmarc.dmarc-reports.cloudflare.net
"v=DMARC1;"
```

This is why two tempting options were rejected:

- **`rua=mailto:…@gmail.com`** — `gmail.com` does not publish authorization
  records for arbitrary domains, and you cannot create one. Reports would
  silently never arrive, while the DMARC record itself looked perfect.
- **`rua=mailto:dmarc@alejoframes.com`** — the **apex has no MX**. Only `send.`
  does, and that is Amazon's bounce handler, not a mailbox. Mail to any
  `@alejoframes.com` address bounces.

That second point generalizes: **`no-reply@alejoframes.com` cannot receive
anything.** A client replying "it never arrived" is writing into the void, and a
sender address that never accepts mail is a mild negative signal in its own
right. Whether to move to a receivable address is an open product decision, not
a technical blocker.

## Policy is `p=none`, on purpose

`p=none` requests reports and changes nothing about how mail is handled. It is
pure instrumentation.

**Do not raise it to `p=quarantine` or `p=reject` without reading the
aggregate reports first.** Under `reject`, legitimate mail that fails alignment
is lost, and the signals that it was lost are ones nobody currently watches.
Most receivers, Gmail included, reject at SMTP time with
`550-5.7.26 … not accepted due to domain's DMARC policy`; SES sees that 5xx and
records a hard bounce, which travels back through the `send.alejoframes.com`
return path documented above and surfaces as a bounce/suppression event in
Resend. The same failures also appear as `dis=reject` counts in the aggregate
reports this file spends a whole section wiring up. Other receivers discard
after acceptance instead, with no signal at all.

So it is not true that nothing is emitted — but nothing reaches a person. The
client never learns their photos are ready, the studio never learns the mail
was dropped, and **nobody is watching Resend's bounce list today**. Two weeks of
report data first, then harden.

`sp=NONE` (subdomain policy) is inherited from `p`. No subdomain is known to
send mail on its own — see the caveat about findash above; that has not been
verified either.

## The evidence that DMARC was the actual fix

Two real Gmail deliveries, same sender, same infrastructure, three days apart.
The only difference in the entire authentication chain is the last line.

**Before (2026-07-28):**

```
dkim=pass header.i=@alejoframes.com header.s=resend
dkim=pass header.i=@amazonses.com
spf=pass  smtp.mailfrom=…@send.alejoframes.com
                                                  ← no dmarc= result at all
```

**After (2026-07-31):**

```
dkim=pass header.i=@alejoframes.com header.s=resend
dkim=pass header.i=@amazonses.com
spf=pass  smtp.mailfrom=…@send.alejoframes.com
dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=alejoframes.com
```

DKIM and SPF were already correct before any change was made. DMARC was not
failing — it did not exist, so the domain made no policy statement for Gmail to
evaluate. Task #152 opened on the assumption that SPF, DKIM and domain
verification were all missing; **that assumption was wrong**, and this record
exists so the next reader starts from the measurement rather than the guess.

## How to re-verify

```bash
dig +short TXT _dmarc.alejoframes.com @1.1.1.1
dig +short TXT resend._domainkey.alejoframes.com @1.1.1.1
dig +short TXT send.alejoframes.com @1.1.1.1
dig +short MX  send.alejoframes.com @1.1.1.1
dig +short TXT alejoframes.com._report._dmarc.dmarc-reports.cloudflare.net @1.1.1.1
```

Query a **public** resolver explicitly. DNS changes propagate; a local cache can
report a stale answer long after the record is right (or wrong).

Then send a real message and read the headers — Gmail's "Show original", the
`Authentication-Results` line. **The folder the message lands in is not the
proof.** Placement depends on recipient-specific reputation and on any
"not spam" the recipient has previously applied to the sender, which
permanently contaminates that inbox as a test signal. The header is computed at
receipt against DNS, before any user rule applies, so it stays trustworthy.

`scripts/check-resend.ts` proves the Resend API responds. **It says nothing
about whether mail is delivered or where it lands.** Do not read a 200 from
Resend as delivery.

## Not verified

- **Outlook/Hotmail.** Not a hypothetical: at least one real client uses a
  `@hotmail.com` address. Outlook applies different content rules and keeps its
  own sender reputation, so a Gmail pass does not transfer.
- **Placement**, as described above.
- **DMARC aggregate reports.** The `rua=` address is published and authorized,
  but no report has been read yet — the first ones arrive roughly 24h after the
  record went live. Until at least two weeks of them have been reviewed, the
  claim "nothing else is sending as this domain" is an expectation, not a
  measurement, and `p=none` stays. This is the gate on moving to
  `p=quarantine`, not a formality.
- **Content scoring for HTML mail.** The verification message was `text/plain`.
  Real mail is `multipart/alternative`. Content filtering is a separate axis
  from authentication — see task #153, which carries the constraint that the
  email redesign must not undo this work by turning a text-heavy, single-link,
  image-free message into a heavy graphical one.
