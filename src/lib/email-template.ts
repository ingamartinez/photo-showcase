// Shared skeleton for the CLIENT-facing (editorial) transactional emails —
// gallery-access-email.ts, gallery-delivery-email.ts and
// gallery-unlock-email.ts. Task #153's own finding: the studio's emails split
// by AUDIENCE exactly like the app does (client vs photographer, see epic
// #125's dashboard-vs-gallery split), so there is no single email style —
// there are two, over one shared base. This module is the CLIENT half of
// that base: warm, editorial, the same brand surface #140 gives the gallery
// itself. The photographer's operational notifications
// (admin-notification-email.ts, missing-final-notification-email.ts) are a
// DIFFERENT, terser variant and are owned by sibling lanes outside this
// task's territory — do not collapse the two into one template with a
// swapped string, which is exactly the error #125 exists to correct on the
// dashboard side.
//
// Hard constraints this file exists to satisfy, carried over verbatim from
// task #153's own brief and infra/email-deliverability.md (task #152):
//
// - SPF/DKIM/DMARC all pass today (`dmarc=pass` verified 2026-07-31), but
//   that is authentication, not content scoring. A beautiful HTML email can
//   still lose on content while passing every auth check — the two are
//   separate axes and this redesign must not trade one for the other.
// - ZERO images. Many clients block remote images by default, and an `<img>`
//   brand mark or a tracking pixel is a content-scoring cost with no product
//   benefit here. The brand is rendered as styled TEXT.
// - Inline styles only, no `<style>` block — Gmail strips anything in
//   `<head>`, so every rule lives in a `style="..."` attribute.
// - `<table>` for layout, not flexbox/grid — Outlook renders with Word's
//   engine, which does not implement either.
// - A single primary link (the CTA `<a>`). Magic links and gallery-access
//   links ARE the payload; a second link (social, "view in browser",
//   decorative unsubscribe) dilutes the one that matters and was explicitly
//   flagged as a regression risk in this task's brief.
// - Light background, chosen deliberately rather than left to chance. Gmail
//   and Apple Mail both invert colors under dark mode on their own terms; a
//   cinema-black surface (the public site's brand, globals.css) risks
//   becoming illegible if a client's mail app decides to invert it again on
//   top of an already-dark background. A light card avoids that interaction
//   entirely. This is the "commit to a light background on purpose" option
//   the task's brief explicitly allows in place of testing every dark-mode
//   permutation across Gmail, Apple Mail and Outlook.
// - No new sending domain, sender address or `From:` shape — this module
//   never touches those; they stay whatever the caller passes to
//   `sendResendEmail` (src/lib/email-transport.ts).
const BRAND_NAME = "ALEJO FRAMES";

// Brand-adjacent but deliberately understated palette: a warm off-white
// card on a slightly deeper warm-grey canvas, near-black warm text, a muted
// taupe for secondary copy. Chosen for legibility with images blocked and
// for staying readable if a mail client applies its own dark-mode filter to
// light backgrounds (which inverts less aggressively than pure white/black).
const COLOR_CANVAS = "#f4f2ee";
const COLOR_CARD = "#ffffff";
const COLOR_INK = "#2a2820";
const COLOR_MUTED = "#8a8578";
const COLOR_RULE = "#e6e2d8";
const FONT_STACK = "Georgia, 'Times New Roman', serif";

export interface EditorialEmailBody {
  /** Greeting + message paragraphs, as trusted HTML (no untrusted input beyond the CTA URL). */
  messageHtml: string;
  ctaUrl: string;
  ctaLabel: string;
  /** The legal/expiry footnote, as trusted HTML. */
  footnoteHtml: string;
}

/**
 * Renders the CLIENT-facing HTML skeleton: one `<table>`-based card with an
 * inline-styled header (brand name as text), the message, a single CTA
 * rendered as a padded `<a>` block (not the default blue link Gmail applies
 * to a bare anchor), and a footnote. Exactly one `<a>` tag, zero `<img>`
 * tags, zero `<style>` tags — verified in email-template.test.ts and
 * mutation-checked so a regression here fails loudly.
 */
export function renderEditorialEmailHtml(body: EditorialEmailBody): string {
  const { messageHtml, ctaUrl, ctaLabel, footnoteHtml } = body;

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLOR_CANVAS};">`,
    '<tr><td align="center" style="padding:32px 16px;">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:${COLOR_CARD};">`,
    "<tr>",
    `<td style="padding:28px 32px 20px 32px;border-bottom:1px solid ${COLOR_RULE};font-family:${FONT_STACK};font-size:13px;letter-spacing:0.18em;color:${COLOR_MUTED};">`,
    BRAND_NAME,
    "</td>",
    "</tr>",
    "<tr>",
    `<td style="padding:28px 32px 8px 32px;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:${COLOR_INK};">`,
    messageHtml,
    "</td>",
    "</tr>",
    "<tr>",
    `<td style="padding:8px 32px 28px 32px;">`,
    `<a href="${ctaUrl}" style="display:inline-block;padding:14px 28px;background-color:${COLOR_INK};color:${COLOR_CANVAS};font-family:${FONT_STACK};font-size:14px;text-decoration:none;letter-spacing:0.03em;">${ctaLabel}</a>`,
    "</td>",
    "</tr>",
    "<tr>",
    `<td style="padding:0 32px 28px 32px;font-family:${FONT_STACK};font-size:13px;line-height:1.5;color:${COLOR_MUTED};">`,
    footnoteHtml,
    "</td>",
    "</tr>",
    "</table>",
    "</td>",
    "</tr>",
    "</table>",
  ].join("\n");
}

export interface EditorialEmailTextBody {
  messageText: string;
  ctaUrl: string;
  /** Defaults to "Entrá a tu galería", matching the pre-#153 text templates. */
  ctaLine?: string;
  footnoteText: string;
}

/**
 * Renders the `text/plain` alternative: the message, a blank line, the
 * link on its own labelled line, a blank line, the footnote. This is the
 * SAME shape the pre-#153 templates already used — task #152 measured that
 * shape as "reads like a real message, not a stripped fallback", and this
 * redesign keeps it rather than degrading it into a "view this email in
 * your browser" placeholder, which the deliverability doc calls out as a
 * negative signal in its own right.
 */
export function renderEditorialEmailText(body: EditorialEmailTextBody): string {
  const { messageText, ctaUrl, ctaLine = "Entrá a tu galería", footnoteText } = body;
  return [messageText, "", `${ctaLine}: ${ctaUrl}`, "", footnoteText].join("\n");
}
