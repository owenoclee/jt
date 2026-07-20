/**
 * ADF -> markdown, lenient. Nodes outside the supported subset render as readable
 * placeholders and set `lossy: true` — the raw ADF stays in the base layer, and the
 * lossy flag warns that editing this description will replace the whole document.
 */
// deno-lint-ignore-file no-explicit-any

export interface AdfToMdResult {
  md: string;
  lossy: boolean;
}

export function adfToMd(adf: unknown): AdfToMdResult {
  if (adf === null || adf === undefined) return { md: "", lossy: false };
  const ctx = { lossy: false };
  const doc = adf as any;
  const md = renderBlocks(doc.content ?? [], ctx).join("\n\n");
  return { md, lossy: ctx.lossy };
}

type Ctx = { lossy: boolean };

function renderBlocks(nodes: any[], ctx: Ctx): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "paragraph": {
        const text = renderInline(n.content ?? [], ctx);
        if (text !== "") out.push(text);
        break;
      }
      case "heading":
        out.push("#".repeat(clampLevel(n.attrs?.level)) + " " + renderInline(n.content ?? [], ctx));
        break;
      case "codeBlock": {
        const lang = n.attrs?.language ?? "";
        const code = (n.content ?? []).map((c: any) => c.text ?? "").join("");
        out.push("```" + lang + "\n" + code + "\n```");
        break;
      }
      case "blockquote": {
        const inner = renderBlocks(n.content ?? [], ctx).join("\n\n");
        out.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        break;
      }
      case "bulletList":
        out.push(renderList(n, ctx, false));
        break;
      case "orderedList":
        out.push(renderList(n, ctx, true));
        break;
      case "rule":
        out.push("---");
        break;
      case "mediaGroup":
      case "mediaSingle":
        ctx.lossy = true;
        out.push("[unsupported: media]");
        break;
      default:
        ctx.lossy = true;
        out.push(`[unsupported: ${n.type}]`);
    }
  }
  return out;
}

function clampLevel(level: unknown): number {
  const n = typeof level === "number" ? level : 1;
  return Math.min(6, Math.max(1, n));
}

function renderList(node: any, ctx: Ctx, ordered: boolean): string {
  const start = ordered ? (typeof node.attrs?.order === "number" ? node.attrs.order : 1) : 0;
  const lines: string[] = [];
  (node.content ?? []).forEach((item: any, i: number) => {
    const marker = ordered ? `${start + i}. ` : "- ";
    const indent = " ".repeat(marker.length);
    const itemBlocks: { text: string; isList: boolean }[] = [];
    for (const child of item.content ?? []) {
      if (child.type === "paragraph") {
        itemBlocks.push({ text: renderInline(child.content ?? [], ctx), isList: false });
      } else if (child.type === "bulletList" || child.type === "orderedList") {
        itemBlocks.push({
          text: renderList(child, ctx, child.type === "orderedList"),
          isList: true,
        });
      } else if (child.type === "codeBlock") {
        const lang = child.attrs?.language ?? "";
        const code = (child.content ?? []).map((c: any) => c.text ?? "").join("");
        itemBlocks.push({ text: "```" + lang + "\n" + code + "\n```", isList: false });
      } else {
        ctx.lossy = true;
        itemBlocks.push({ text: `[unsupported: ${child.type}]`, isList: false });
      }
    }
    // Nested lists attach tightly (no blank line); other sibling blocks separate normally.
    let body = "";
    itemBlocks.forEach((blk, bi) => {
      if (bi > 0) body += blk.isList ? "\n" : "\n\n";
      body += blk.text;
    });
    const bodyLines = body.split("\n");
    lines.push(marker + (bodyLines[0] ?? ""));
    for (const l of bodyLines.slice(1)) lines.push(l ? indent + l : "");
  });
  return lines.join("\n");
}

function renderInline(nodes: any[], ctx: Ctx): string {
  let out = "";
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        out += applyMarks(n.text ?? "", n.marks ?? []);
        break;
      case "hardBreak":
        out += "  \n";
        break;
      case "mention":
        ctx.lossy = true;
        out += `@${String(n.attrs?.text ?? "user").replace(/^@/, "")}`;
        break;
      case "emoji":
        ctx.lossy = true;
        out += n.attrs?.shortName ?? "";
        break;
      case "inlineCard":
        ctx.lossy = true;
        out += n.attrs?.url ?? "[card]";
        break;
      case "status":
        ctx.lossy = true;
        out += `[${n.attrs?.text ?? "status"}]`;
        break;
      case "date":
        ctx.lossy = true;
        out += n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "[date]";
        break;
      default:
        ctx.lossy = true;
        out += `[unsupported: ${n.type}]`;
    }
  }
  return out;
}

function applyMarks(text: string, marks: any[]): string {
  const types = new Set(marks.map((m: any) => m.type));
  let out: string;
  if (types.has("code")) {
    // Code marks suppress other formatting; pick a fence that doesn't collide.
    const fence = text.includes("`") ? "``" : "`";
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    out = `${fence}${pad}${text}${pad}${fence}`;
  } else {
    out = escapeMdText(text);
    if (types.has("strike")) out = `~~${out}~~`;
    if (types.has("em")) out = `*${out}*`;
    if (types.has("strong")) out = `**${out}**`;
  }
  const link = marks.find((m: any) => m.type === "link");
  if (link) out = `[${out}](${link.attrs?.href ?? ""})`;
  return out;
}

/**
 * Escape characters that would otherwise be re-parsed as markdown syntax, so that
 * fetched plain text round-trips through mdToAdf unchanged.
 */
export function escapeMdText(text: string): string {
  let out = text.replace(/([\\`*_[\]~])/g, "\\$1");
  // "<" only matters when it could open a tag or autolink.
  out = out.replace(/<(?=[A-Za-z/!?])/g, "\\<");
  // Line-start constructs: #, >, list markers, and ordered-list numbers.
  out = out.replace(/(^|\n)(\s*)(#{1,6} |> |[-+] |\d+[.)] )/g, (_m, brk, ws, marker) => {
    return `${brk}${ws}\\${marker}`;
  });
  return out;
}
