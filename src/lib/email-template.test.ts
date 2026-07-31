import { describe, expect, it } from "vitest";
import { renderEditorialEmailHtml, renderEditorialEmailText } from "./email-template";

const CTA_URL = "https://alejoframes.com/api/auth/callback/gallery-access?token=abc";

describe("renderEditorialEmailHtml", () => {
  const html = renderEditorialEmailHtml({
    messageHtml: '<p style="margin:0;">Hola,</p><p style="margin:0;">Cuerpo del mensaje.</p>',
    ctaUrl: CTA_URL,
    ctaLabel: "Ver mis fotos",
    footnoteHtml: "Nota al pie.",
  });

  // Deliverability constraint from #152/#153: zero remote images. Many
  // clients block them by default, so an <img> here would be a
  // content-scoring cost with no product benefit. Mutation-checked below.
  it("contains no <img> tags", () => {
    expect(html).not.toMatch(/<img[\s>]/i);
  });

  // Gmail strips <style> blocks in <head>; a rule placed there would
  // silently never apply. Every rule must live in a style="" attribute
  // instead, which this test does not directly prove, but the absence of
  // <style> at least rules out the failure mode of relying on it.
  it("contains no <style> tag", () => {
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  // Outlook's Word rendering engine does not implement flexbox or grid;
  // layout must be table-based.
  it("uses <table> for layout", () => {
    expect(html).toMatch(/<table/i);
  });

  // No CSS classes: Gmail discards <style> in <head>, so anything expressed
  // only via a class with no matching inline style would not render at all.
  it("uses no class attributes", () => {
    expect(html).not.toMatch(/class=/i);
  });

  // Single primary link — the acceptance criterion this task's brief calls
  // out explicitly ("keep it to a single primary link"). Counting <a> tags
  // (not just asserting the URL is present, which a second decorative link
  // would also satisfy) is the assertion that actually catches a regression
  // here.
  it("contains exactly one <a> tag, pointing at the CTA URL", () => {
    const anchorMatches = html.match(/<a\s/gi) ?? [];
    expect(anchorMatches).toHaveLength(1);
    expect(html).toContain(`href="${CTA_URL}"`);
  });

  it("renders the CTA label inside the single anchor, styled as a button rather than a bare link", () => {
    expect(html).toMatch(/<a[^>]*style="[^"]*display:inline-block[^"]*"[^>]*>Ver mis fotos<\/a>/);
  });

  // Light-background-on-purpose decision (see email-template.ts header
  // comment): codified here so a change to a dark canvas is a deliberate
  // edit to this test, not a silent regression.
  it("uses a light canvas background, per the deliberate light-mode decision", () => {
    expect(html).toContain("background-color:#f4f2ee;");
  });

  it("includes the brand name as plain text, not as an image", () => {
    expect(html).toContain("ALEJO FRAMES");
  });

  it("embeds the message and footnote content passed in", () => {
    expect(html).toContain("Cuerpo del mensaje.");
    expect(html).toContain("Nota al pie.");
  });
});

describe("renderEditorialEmailText", () => {
  it("produces the exact message / blank / link line / blank / footnote shape", () => {
    const text = renderEditorialEmailText({
      messageText: "Cuerpo del mensaje.",
      ctaUrl: CTA_URL,
      footnoteText: "Nota al pie.",
    });

    expect(text).toBe(
      ["Cuerpo del mensaje.", "", `Entrá a tu galería: ${CTA_URL}`, "", "Nota al pie."].join("\n"),
    );
  });

  it("honors a custom ctaLine instead of the default", () => {
    const text = renderEditorialEmailText({
      messageText: "Cuerpo.",
      ctaUrl: CTA_URL,
      ctaLine: "Entrá a la galería",
      footnoteText: "Nota.",
    });

    expect(text).toContain(`Entrá a la galería: ${CTA_URL}`);
    expect(text).not.toContain("Entrá a tu galería:");
  });

  it("contains no HTML tags", () => {
    const text = renderEditorialEmailText({
      messageText: "Cuerpo.",
      ctaUrl: CTA_URL,
      footnoteText: "Nota.",
    });

    expect(text).not.toContain("<");
  });
});
