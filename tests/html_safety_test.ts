/** What reaches a review page as HTML: markdown from Jira is rendered, never trusted. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { mdToHtml, renderPage, type ReviewPageModel } from "../src/review/html.ts";

Deno.test("raw HTML in markdown is shown as text, not handed to the browser", () => {
  const html = mdToHtml("before\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)> after");
  assert(!html.includes("<script"), html);
  assert(!html.includes("<img"), html);
  assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

Deno.test("only links to the web keep their target", () => {
  assertStringIncludes(mdToHtml("[docs](https://example.com/a?b=1)"), 'href="https://example.com/a?b=1"');
  assertStringIncludes(mdToHtml("[mail](mailto:a@example.com)"), 'href="mailto:a@example.com"');
  for (const target of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "/p/SBX/other", "vbscript:x"]) {
    const html = mdToHtml(`[click me](${target})`);
    assert(!html.includes("href"), `${target} kept its href: ${html}`);
    assertStringIncludes(html, "click me");
  }
  // Formatting inside a dropped link survives.
  assertStringIncludes(mdToHtml("[**bold**](javascript:x)"), "<strong>bold</strong>");
});

Deno.test("images are not loaded: only their text is shown", () => {
  const html = mdToHtml("![a diagram](https://tracker.example/pixel.png)");
  assert(!html.includes("<img"), html);
  assertStringIncludes(html, "a diagram");
});

Deno.test("ordinary markdown still renders", () => {
  const html = mdToHtml("# Title\n\n- one\n- `two`\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  assertStringIncludes(html, "<h1>Title</h1>");
  assertStringIncludes(html, "<code>two</code>");
  assertStringIncludes(html, "<table>");
});

const page = (extra: Partial<ReviewPageModel>): ReviewPageModel => ({
  mode: "readonly",
  title: "a page",
  target: { baseUrl: "https://example.atlassian.net", project: "TST" },
  tickets: [],
  commits: [],
  sinceReview: null,
  nonce: "",
  ...extra,
});

Deno.test("a served page carries the CSP nonce on its style and script; a file page has none", () => {
  const served = renderPage(page({ cspNonce: "abc123" }));
  assertStringIncludes(served, '<style nonce="abc123">');
  assertStringIncludes(served, '<script nonce="abc123">');
  const file = renderPage(page({}));
  assertStringIncludes(file, "<style>");
  assertStringIncludes(file, "<script>");
});

Deno.test("a proposal's title, name and comments are escaped into its page", () => {
  const evil = `"><script>alert(1)</script>`;
  const html = renderPage(page({
    cspNonce: "n",
    tickets: [{ id: "TST-1", summary: evil, kind: "update", unchangedSinceReview: false, diffHtml: "", opsJson: "" }],
    proposal: {
      name: "p",
      workspace: evil,
      title: evil,
      descriptionHtml: mdToHtml(evil),
      status: { label: evil, tone: "wait" },
      banners: [{ tone: "warn", text: evil }],
      comments: { label: evil, items: [{ body: evil }, { on: "TST-1", body: evil }] },
      inboxUrl: "/",
    },
  }));
  assertEquals(html.match(/<script(?! nonce="n">)/g), null, "no script but the page's own");
});
