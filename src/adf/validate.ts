/**
 * ADF schema constraints that markdown can express but Jira rejects.
 *
 * The markdown subset (md_to_adf.ts) decides what *syntax* is allowed; this file
 * decides what the resulting *document* is allowed to look like. ADF is stricter than
 * markdown in a handful of places — a code span cannot also be bold, a quote cannot
 * hold a heading — and Jira only says so when the document is submitted, which under
 * `jt push` is after a human has already approved the changeset. Everything here is
 * therefore checked at `jt commit`, in the agent's own edit loop.
 *
 * Rules are from the ADF node/mark reference:
 * https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 *
 * Each one was confirmed against a live Jira Cloud site: every construct below is
 * refused with `400 {"errorMessages":["INVALID_INPUT"],"errors":{}}` — no field, no
 * position, no mention of which rule was broken. A code span carrying a link is
 * accepted and stored verbatim, so that combination stays legal here.
 */
import { UserError } from "../errors.ts";
import type { AdfDoc, AdfNode } from "./md_to_adf.ts";

/** Markdown that is in the subset but compiles to a document Jira's ADF schema rejects. */
export class AdfConstraintError extends UserError {}

/** `code` may only share a text node with `link` — every other mark is a conflict. */
export const CODE_COMPATIBLE_MARKS = new Set(["link"]);

/** blockquote content: no headings, rules or nested quotes. */
export const BLOCKQUOTE_CHILDREN = new Set([
  "paragraph",
  "bulletList",
  "orderedList",
  "codeBlock",
  "mediaGroup",
  "mediaSingle",
]);

/** listItem content: same shape, minus media groups. */
export const LIST_ITEM_CHILDREN = new Set([
  "paragraph",
  "bulletList",
  "orderedList",
  "codeBlock",
  "mediaSingle",
]);

const MARK_LABEL: Record<string, string> = {
  strong: "bold",
  em: "italic",
  strike: "strikethrough",
  underline: "underline",
  subsup: "superscript/subscript",
  textColor: "coloured text",
};

export function describeMark(type: string): string {
  return MARK_LABEL[type] ?? type;
}

/**
 * Last-resort structural sweep over a built document. The builder raises friendlier,
 * located errors for the constraints it can see coming (see md_to_adf.ts); this catches
 * anything that slips past, so an invalid document can never reach a review page.
 */
export function validateAdf(doc: AdfDoc): string[] {
  const problems: string[] = [];
  walk(doc.content ?? [], "doc", problems);
  return problems;
}

function walk(nodes: AdfNode[], parent: string, problems: string[]): void {
  for (const node of nodes) {
    if (parent === "blockquote" && !BLOCKQUOTE_CHILDREN.has(node.type)) {
      problems.push(`a blockquote cannot contain a ${node.type}`);
    }
    if (parent === "listItem" && !LIST_ITEM_CHILDREN.has(node.type)) {
      problems.push(`a list item cannot contain a ${node.type}`);
    }
    switch (node.type) {
      case "text": {
        if (!node.text) problems.push("empty text node");
        const marks = (node.marks ?? []).map((m) => m.type);
        if (marks.includes("code")) {
          const conflicts = marks.filter((m) => m !== "code" && !CODE_COMPATIBLE_MARKS.has(m));
          if (conflicts.length) {
            problems.push(
              `the code mark cannot be combined with ${
                conflicts.map(describeMark).join(" or ")
              } (text: ${JSON.stringify(node.text ?? "")})`,
            );
          }
        }
        if (parent === "codeBlock" && marks.length) {
          problems.push("text inside a code block cannot carry formatting marks");
        }
        const link = (node.marks ?? []).find((m) => m.type === "link");
        if (link && !String((link.attrs as { href?: string })?.href ?? "")) {
          problems.push(`link has no target (text: ${JSON.stringify(node.text ?? "")})`);
        }
        break;
      }
      case "heading": {
        const level = (node.attrs as { level?: number } | undefined)?.level;
        if (typeof level !== "number" || level < 1 || level > 6) {
          problems.push(`heading level must be 1-6 (got ${String(level)})`);
        }
        break;
      }
      case "bulletList":
      case "orderedList":
        if (!node.content?.length) problems.push(`an empty ${node.type} is not valid`);
        for (const item of node.content ?? []) {
          if (item.type !== "listItem") problems.push(`${node.type} may only contain list items`);
        }
        break;
      case "listItem":
        if (!node.content?.length) problems.push("a list item must have content");
        break;
    }
    if (node.content) walk(node.content, node.type, problems);
  }
}

/** Throws if the document violates any constraint. `where` names the field, if known. */
export function assertValidAdf(doc: AdfDoc, where?: string): void {
  const problems = validateAdf(doc);
  if (problems.length === 0) return;
  const prefix = where ? `${where}: ` : "";
  throw new AdfConstraintError(
    `${prefix}the result is not valid Jira rich text (ADF):\n` +
      problems.map((p) => `  ${p}`).join("\n"),
  );
}
