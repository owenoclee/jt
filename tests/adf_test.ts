import { assert, assertEquals, assertThrows } from "@std/assert";
import { adfToMd } from "../src/adf/adf_to_md.ts";
import { mdToAdf, UnsupportedMarkdownError } from "../src/adf/md_to_adf.ts";
import { AdfConstraintError, validateAdf } from "../src/adf/validate.ts";

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

Deno.test("ADF constraint violations are located, explained errors", () => {
  const cases: { md: string; expect: RegExp }[] = [
    { md: "intro\n\n**bold `code` here**", expect: /line 3: inline code cannot also be bold/ },
    { md: "*ital `c`*", expect: /line 1: inline code cannot also be italic/ },
    { md: "~~struck `c`~~", expect: /inline code cannot also be strikethrough/ },
    { md: "> # heading in a quote", expect: /a heading cannot go inside a blockquote/ },
    { md: "> > nested", expect: /a blockquote cannot go inside a blockquote/ },
    { md: "> ---", expect: /a horizontal rule cannot go inside a blockquote/ },
    { md: "- item\n\n  > quoted", expect: /a blockquote cannot go inside a list item/ },
    { md: "- item\n  # h", expect: /a heading cannot go inside a list item/ },
  ];
  for (const { md, expect } of cases) {
    const err = assertThrows(() => mdToAdf(md), AdfConstraintError, undefined, md);
    assert(
      expect.test((err as Error).message),
      `${JSON.stringify(md)} → ${(err as Error).message}`,
    );
  }
});

Deno.test("a code span may still carry a link, and formatting outside it is fine", () => {
  assertEquals(
    mdToAdf("[`code`](https://x.io)").content[0].content![0].marks?.map((m) => m.type),
    ["link", "code"],
  );
  assertEquals(mdToAdf("**bold** `code`").content.length, 1);
});

Deno.test("constraint errors name the field they came from", () => {
  const err = assertThrows(() => mdToAdf("**`x`**", "description"), AdfConstraintError);
  assert((err as Error).message.startsWith("description line 1:"), (err as Error).message);
});

Deno.test("validateAdf catches documents built outside the markdown path", () => {
  const bad = {
    version: 1 as const,
    type: "doc" as const,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "x", marks: [{ type: "strong" }, { type: "code" }] }],
      },
      { type: "blockquote", content: [{ type: "rule" }] },
      { type: "paragraph", content: [{ type: "text", text: "" }] },
    ],
  };
  const problems = validateAdf(bad);
  assertEquals(problems.length, 3);
  assert(problems.some((p) => p.includes("code mark cannot be combined with bold")));
  assert(problems.some((p) => p.includes("a blockquote cannot contain a rule")));
  assert(problems.some((p) => p.includes("empty text node")));
});

Deno.test("empty markdown runs do not produce empty ADF text nodes", () => {
  const doc = mdToAdf("[](https://x.io)\n\ntext");
  assertEquals(validateAdf(doc), []);
});
