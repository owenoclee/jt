/**
 * Deterministic markdown -> ADF over a bounded subset:
 * headings, paragraphs, bullet/ordered lists, fenced code blocks, blockquotes,
 * horizontal rules, bold/italic/inline-code/strikethrough/links, hard breaks.
 *
 * Anything outside the subset is a hard error at compile time — strict on write,
 * lenient on read (see adf_to_md.ts).
 */
// deno-lint-ignore-file no-explicit-any
import { Lexer } from "marked";
import { UserError } from "../errors.ts";

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

type Mark = { type: string; attrs?: Record<string, unknown> };

export class UnsupportedMarkdownError extends UserError {
  constructor(construct: string) {
    super(
      `unsupported markdown construct: ${construct}. Supported: headings, paragraphs, ` +
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

export function mdToAdf(md: string): AdfDoc {
  const tokens = new Lexer({ gfm: true }).lex(md);
  return { version: 1, type: "doc", content: blocks(tokens) };
}

function blocks(tokens: any[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "space":
        break;
      case "heading":
        out.push({
          type: "heading",
          attrs: { level: t.depth },
          content: inline(t.tokens ?? [], []),
        });
        break;
      case "paragraph":
        out.push({ type: "paragraph", content: inline(t.tokens ?? [], []) });
        break;
      case "text":
        // Stray top-level text (e.g. inside tight blockquotes) — treat as a paragraph.
        out.push({ type: "paragraph", content: inline(t.tokens ?? [t], []) });
        break;
      case "code": {
        const attrs = t.lang ? { language: t.lang } : undefined;
        out.push({
          type: "codeBlock",
          ...(attrs ? { attrs } : {}),
          content: t.text ? [{ type: "text", text: t.text }] : [],
        });
        break;
      }
      case "blockquote":
        out.push({ type: "blockquote", content: blocks(t.tokens ?? []) });
        break;
      case "list":
        out.push(list(t));
        break;
      case "hr":
        out.push({ type: "rule" });
        break;
      default:
        throw new UnsupportedMarkdownError(t.type);
    }
  }
  return out;
}

function list(t: any): AdfNode {
  const items: AdfNode[] = [];
  for (const item of t.items) {
    if (item.task) throw new UnsupportedMarkdownError("task list");
    const content: AdfNode[] = [];
    for (const child of item.tokens ?? []) {
      if (child.type === "text") {
        content.push({ type: "paragraph", content: inline(child.tokens ?? [child], []) });
      } else if (child.type === "list") {
        content.push(list(child));
      } else if (child.type === "paragraph") {
        content.push({ type: "paragraph", content: inline(child.tokens ?? [], []) });
      } else if (child.type === "code") {
        const attrs = child.lang ? { language: child.lang } : undefined;
        content.push({
          type: "codeBlock",
          ...(attrs ? { attrs } : {}),
          content: child.text ? [{ type: "text", text: child.text }] : [],
        });
      } else if (child.type === "space") {
        // ignore
      } else {
        throw new UnsupportedMarkdownError(`${child.type} inside list item`);
      }
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

function inline(tokens: any[], marks: Mark[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        out.push(textNode(t.text, marks));
        break;
      case "escape":
        out.push(textNode(t.text, marks));
        break;
      case "strong":
        out.push(...inline(t.tokens ?? [], [...marks, { type: "strong" }]));
        break;
      case "em":
        out.push(...inline(t.tokens ?? [], [...marks, { type: "em" }]));
        break;
      case "del":
        out.push(...inline(t.tokens ?? [], [...marks, { type: "strike" }]));
        break;
      case "codespan":
        out.push(textNode(t.text, [...marks, { type: "code" }]));
        break;
      case "link":
        out.push(
          ...inline(t.tokens ?? [], [...marks, { type: "link", attrs: { href: t.href } }]),
        );
        break;
      case "br":
        out.push({ type: "hardBreak" });
        break;
      default:
        throw new UnsupportedMarkdownError(`inline ${t.type}`);
    }
  }
  return mergeAdjacentText(out);
}

function textNode(text: string, marks: Mark[]): AdfNode {
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
