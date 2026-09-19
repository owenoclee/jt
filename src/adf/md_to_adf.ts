/**
 * Deterministic markdown -> ADF over a bounded subset:
 * headings, paragraphs, bullet/ordered lists, fenced code blocks, blockquotes,
 * horizontal rules, bold/italic/inline-code/strikethrough/links, hard breaks.
 *
 * Anything outside the subset is a hard error at compile time — strict on write,
 * lenient on read (see adf_to_md.ts). Constructs that are inside the subset but would
 * build a document Jira's ADF schema rejects (a bold code span, a heading in a quote)
 * are errors too, reported with the offending line and a rewrite — see validate.ts.
 */
// deno-lint-ignore-file no-explicit-any
import { Lexer } from "marked";
import { UserError } from "../errors.ts";
import { AdfConstraintError, assertValidAdf, describeMark } from "./validate.ts";

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

type Mark = { type: string; attrs?: Record<string, unknown> };

export class UnsupportedMarkdownError extends UserError {
  constructor(construct: string, at: string) {
    super(
      `${at}unsupported markdown construct: ${construct}. Supported: headings, paragraphs, ` +
        `bullet/ordered lists, fenced code blocks, blockquotes, horizontal rules, ` +
        `bold, italic, inline code, strikethrough, links.`,
    );
  }
}

export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

/**
 * Tracks where in the source markdown the current block started, so errors can name a
 * line and quote the offending text. Nested tokens (inside quotes and list items) carry
 * raw text with their container's markers stripped, so a lookup that misses falls back
 * to the enclosing top-level block — a line that is always in the right neighbourhood.
 */
class Source {
  #md: string;
  #cursor = 0;
  #blockStart = 0;
  #blockRaw: string;

  constructor(md: string) {
    this.#md = md;
    this.#blockRaw = md;
  }

  /** Enter a top-level block: subsequent line numbers are relative to it. */
  enter(raw: string): void {
    const at = this.#md.indexOf(raw, this.#cursor);
    if (at < 0) return;
    this.#blockStart = at;
    this.#blockRaw = raw;
  }

  /** Leave a top-level block, so the next lookup starts after it. */
  leave(raw: string): void {
    const at = this.#md.indexOf(raw, this.#cursor);
    if (at >= 0) this.#cursor = at + raw.length;
  }

  /** "line 4: " for the given snippet, or for the current block when it isn't found. */
  at(snippet?: string): string {
    let offset = this.#blockStart;
    if (snippet) {
      const within = this.#blockRaw.indexOf(snippet);
      if (within >= 0) offset += within;
    }
    const line = this.#md.slice(0, offset).split("\n").length;
    return `line ${line}: `;
  }
}

interface Ctx {
  src: Source;
  /** Field this markdown came from ("description", "comment 2"), for error prefixes. */
  where?: string;
}

export function mdToAdf(md: string, where?: string): AdfDoc {
  const tokens = new Lexer({ gfm: true }).lex(md);
  const ctx: Ctx = { src: new Source(md), where };
  const doc: AdfDoc = { version: 1, type: "doc", content: blocks(tokens, ctx, "doc", true) };
  assertValidAdf(doc, where);
  return doc;
}

type Container = "doc" | "blockquote" | "listItem";

const CONTAINER_LABEL: Record<Container, string> = {
  doc: "document",
  blockquote: "blockquote",
  listItem: "list item",
};

/** What ADF allows directly inside each container (see validate.ts for the source). */
const ALLOWED: Record<Container, Set<string>> = {
  doc: new Set([
    "heading",
    "paragraph",
    "codeBlock",
    "blockquote",
    "bulletList",
    "orderedList",
    "rule",
  ]),
  blockquote: new Set(["paragraph", "codeBlock", "bulletList", "orderedList"]),
  listItem: new Set(["paragraph", "codeBlock", "bulletList", "orderedList"]),
};

const NODE_LABEL: Record<string, string> = {
  heading: "a heading",
  rule: "a horizontal rule",
  blockquote: "a blockquote",
  codeBlock: "a code block",
  paragraph: "a paragraph",
  bulletList: "a bullet list",
  orderedList: "a numbered list",
};

function checkPlacement(node: AdfNode, container: Container, ctx: Ctx, raw?: string): void {
  if (ALLOWED[container].has(node.type)) return;
  const allowed = "paragraphs, lists and code blocks";
  throw new AdfConstraintError(
    `${prefix(ctx)}${ctx.src.at(raw)}${
      NODE_LABEL[node.type] ?? `a ${node.type}`
    } cannot go inside ` +
      `${container === "listItem" ? "a list item" : "a blockquote"} — Jira's rich text (ADF) ` +
      `allows only ${allowed} there\n` +
      `  ${firstLine(raw)}\n` +
      `  move it out of the ${CONTAINER_LABEL[container]}, or write it as a paragraph`,
  );
}

function prefix(ctx: Ctx): string {
  return ctx.where ? `${ctx.where} ` : "";
}

function firstLine(raw?: string): string {
  const line = (raw ?? "").split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function blocks(tokens: any[], ctx: Ctx, container: Container, top = false): AdfNode[] {
  const out: AdfNode[] = [];
  for (const t of tokens) {
    if (top && typeof t.raw === "string") ctx.src.enter(t.raw);
    const node = block(t, ctx);
    if (node) {
      checkPlacement(node, container, ctx, t.raw);
      out.push(node);
    }
    if (top && typeof t.raw === "string") ctx.src.leave(t.raw);
  }
  return out;
}

function block(t: any, ctx: Ctx): AdfNode | null {
  switch (t.type) {
    case "space":
      return null;
    case "heading":
      return {
        type: "heading",
        attrs: { level: t.depth },
        content: inline(t.tokens ?? [], [], ctx),
      };
    case "paragraph":
      return { type: "paragraph", content: inline(t.tokens ?? [], [], ctx) };
    case "text":
      // Stray top-level text (e.g. inside tight blockquotes) — treat as a paragraph.
      return { type: "paragraph", content: inline(t.tokens ?? [t], [], ctx) };
    case "code":
      return codeBlock(t);
    case "blockquote":
      return { type: "blockquote", content: blocks(t.tokens ?? [], ctx, "blockquote") };
    case "list":
      return list(t, ctx);
    case "hr":
      return { type: "rule" };
    default:
      throw new UnsupportedMarkdownError(t.type, prefix(ctx) + ctx.src.at(t.raw));
  }
}

function codeBlock(t: any): AdfNode {
  const attrs = t.lang ? { language: t.lang } : undefined;
  return {
    type: "codeBlock",
    ...(attrs ? { attrs } : {}),
    content: t.text ? [{ type: "text", text: t.text }] : [],
  };
}

function list(t: any, ctx: Ctx): AdfNode {
  const items: AdfNode[] = [];
  for (const item of t.items) {
    if (item.task) {
      throw new UnsupportedMarkdownError("task list", prefix(ctx) + ctx.src.at(item.raw));
    }
    const content: AdfNode[] = [];
    for (const child of item.tokens ?? []) {
      if (child.type === "space") continue;
      let node: AdfNode;
      if (child.type === "text") {
        node = { type: "paragraph", content: inline(child.tokens ?? [child], [], ctx) };
      } else if (child.type === "list") {
        node = list(child, ctx);
      } else if (child.type === "paragraph") {
        node = { type: "paragraph", content: inline(child.tokens ?? [], [], ctx) };
      } else if (child.type === "code") {
        node = codeBlock(child);
      } else if (child.type === "blockquote" || child.type === "heading" || child.type === "hr") {
        // In the subset, but ADF has no place for them inside a list item.
        const type = child.type === "hr" ? "rule" : child.type;
        checkPlacement({ type }, "listItem", ctx, child.raw);
        continue; // unreachable: checkPlacement always throws here
      } else {
        throw new UnsupportedMarkdownError(
          `${child.type} inside list item`,
          prefix(ctx) + ctx.src.at(child.raw),
        );
      }
      checkPlacement(node, "listItem", ctx, child.raw);
      content.push(node);
    }
    if (content.length === 0) content.push({ type: "paragraph", content: [] });
    items.push({ type: "listItem", content });
  }
  if (t.ordered) {
    return {
      type: "orderedList",
      attrs: { order: typeof t.start === "number" && t.start !== "" ? t.start : 1 },
      content: items,
    };
  }
  return { type: "bulletList", content: items };
}

/** Canonical mark ordering so identical formatting always serializes identically. */
const MARK_PRIORITY: Record<string, number> = { link: 0, strong: 1, em: 2, strike: 3, code: 4 };

/**
 * `outer` is the raw markdown of the outermost emphasis being applied, so an error
 * about a mark combination can quote the whole construct rather than the code span
 * alone.
 */
function inline(tokens: any[], marks: Mark[], ctx: Ctx, outer?: string): AdfNode[] {
  const out: AdfNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "text":
      case "escape":
        push(out, textNode(t.text, marks));
        break;
      case "strong":
        out.push(...inline(t.tokens ?? [], [...marks, { type: "strong" }], ctx, outer ?? t.raw));
        break;
      case "em":
        out.push(...inline(t.tokens ?? [], [...marks, { type: "em" }], ctx, outer ?? t.raw));
        break;
      case "del":
        out.push(...inline(t.tokens ?? [], [...marks, { type: "strike" }], ctx, outer ?? t.raw));
        break;
      case "codespan":
        checkCodeMarks(marks, outer ?? t.raw, ctx);
        push(out, textNode(t.text, [...marks, { type: "code" }]));
        break;
      case "link":
        out.push(
          ...inline(
            t.tokens ?? [],
            [...marks, { type: "link", attrs: { href: t.href } }],
            ctx,
            outer,
          ),
        );
        break;
      case "br":
        out.push({ type: "hardBreak" });
        break;
      default:
        throw new UnsupportedMarkdownError(`inline ${t.type}`, prefix(ctx) + ctx.src.at(t.raw));
    }
  }
  return mergeAdjacentText(out);
}

/**
 * The one ADF rule agents trip over most: `code` may share a text node only with
 * `link`, so `**bold `code`**` is rejected by Jira even though it is ordinary markdown.
 */
function checkCodeMarks(marks: Mark[], raw: string | undefined, ctx: Ctx): void {
  const conflicts = marks.map((m) => m.type).filter((m) => m !== "link" && m !== "code");
  if (conflicts.length === 0) return;
  const names = [...new Set(conflicts.map(describeMark))];
  throw new AdfConstraintError(
    `${prefix(ctx)}${ctx.src.at(raw)}inline code cannot also be ${names.join(" and ")} — ` +
      `Jira's rich text (ADF) lets a code span carry a link and nothing else\n` +
      `  ${firstLine(raw)}\n` +
      `  put the formatting outside the code span instead: **bold** \`code\``,
  );
}

/** ADF text nodes must not be empty; markdown can produce empty runs, so drop them. */
function push(out: AdfNode[], node: AdfNode | null): void {
  if (node) out.push(node);
}

function textNode(text: string, marks: Mark[]): AdfNode | null {
  if (!text) return null;
  if (marks.length === 0) return { type: "text", text };
  const sorted = [...marks].sort(
    (a, b) => (MARK_PRIORITY[a.type] ?? 9) - (MARK_PRIORITY[b.type] ?? 9),
  );
  return { type: "text", text, marks: sorted };
}

function mergeAdjacentText(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (
      prev && prev.type === "text" && n.type === "text" &&
      JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])
    ) {
      prev.text = (prev.text ?? "") + (n.text ?? "");
    } else {
      out.push(n);
    }
  }
  return out;
}
