import { assert, assertEquals, assertThrows } from "@std/assert";
import { adfToMd } from "../src/adf/adf_to_md.ts";
import { mdToAdf, UnsupportedMarkdownError } from "../src/adf/md_to_adf.ts";

/** md that is already in canonical form must round-trip byte-identically. */
const CANONICAL_SAMPLES = [
  "hello world",
  "# Heading\n\nA paragraph with **bold**, *italic*, `code`, and ~~strike~~.",
  "## Sub\n\n- one\n- two\n- three",
  "1. first\n2. second",
  "```ts\nconst x = 1;\n```",
  "> quoted text\n> more",
  "a [link](https://example.com) here",
  "para one\n\npara two\n\n---\n\npara three",
  "- item with **bold**\n- item with `code`",
  "line one  \nline two",
  "text with & ampersand and 5 < 6",
];

Deno.test("md -> adf -> md round-trips canonical markdown", () => {
  for (const md of CANONICAL_SAMPLES) {
    const adf = mdToAdf(md);
    const back = adfToMd(adf);
    assertEquals(back.md, md, `round-trip failed for: ${JSON.stringify(md)}`);
    assertEquals(back.lossy, false);
  }
});

Deno.test("adfToMd output is a fixed point (stable after one round-trip)", () => {
  const awkward = [
    "text with *literal asterisks* not intended\\* as emphasis",
    "underscore_in_identifier and my_var",
    "a line\nwith a soft break",
  ];
  for (const md of awkward) {
    const once = adfToMd(mdToAdf(md)).md;
    const twice = adfToMd(mdToAdf(once)).md;
    assertEquals(twice, once, `not a fixed point: ${JSON.stringify(md)}`);
  }
});

Deno.test("adf -> md -> adf preserves subset ADF semantics", () => {
  const doc = {
    version: 1 as const,
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "plain " },
          { type: "text", text: "bold", marks: [{ type: "strong" }] },
          { type: "text", text: " and " },
          { type: "text", text: "lnk", marks: [{ type: "link", attrs: { href: "https://x.io" } }] },
        ],
      },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
        ],
      },
      { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "let a = 1;" }] },
    ],
  };
  const { md, lossy } = adfToMd(doc);
  assertEquals(lossy, false);
  const back = mdToAdf(md);
  assertEquals<unknown>(back, doc);
});

Deno.test("unsupported ADF nodes render placeholders and set lossy", () => {
  const doc = {
    version: 1,
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before " }, { type: "mention", attrs: { text: "@owen" } }] },
      { type: "table", content: [] },
    ],
  };
  const { md, lossy } = adfToMd(doc);
  assert(lossy);
  assert(md.includes("@owen"));
  assert(md.includes("[unsupported: table]"));
});

Deno.test("unsupported markdown constructs are hard errors", () => {
  assertThrows(() => mdToAdf("| a | b |\n|---|---|\n| 1 | 2 |"), UnsupportedMarkdownError);
  assertThrows(() => mdToAdf("![image](https://example.com/x.png)"), UnsupportedMarkdownError);
  assertThrows(() => mdToAdf("<div>html</div>"), UnsupportedMarkdownError);
  assertThrows(() => mdToAdf("- [ ] task item"), UnsupportedMarkdownError);
});

Deno.test("nested lists round-trip", () => {
  const md = "- outer\n  - inner one\n  - inner two\n- second";
  const adf = mdToAdf(md);
  const back = adfToMd(adf);
  assertEquals(back.md, md);
});

Deno.test("code marks pick safe fences", () => {
  const doc = {
    version: 1 as const,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "a`b", marks: [{ type: "code" }] }],
      },
    ],
  };
  const { md } = adfToMd(doc);
  const back = mdToAdf(md);
  assertEquals<unknown>(back, doc);
});
