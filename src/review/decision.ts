/**
 * Acting on the human's decision about a proposal: Approve & push (the WHOLE changeset)
 * or Request changes (nothing sent; the comments go back to the proposal's agent).
 * The process that rendered the page is the one that sends it, and an approved
 * changeset is sent whole: what was shown is exactly what ships, as a unit. Decision
 * provenance (latency, user agent) lands in the journal.
 */
import type { AutoVerdict } from "../autoallow.ts";
import { readChain, writeReviewMarker } from "../chain.ts";
import {
  checkStaleness,
  executePush,
  leftoverNotice,
  type Print,
  type PushContext,
} from "../commands/push.ts";
import type { CompiledPush } from "../compile.ts";
import { UserError } from "../errors.ts";
import { bold, cyan, dim, green, red } from "../render/colors.ts";
import type { ReviewComment } from "../types.ts";

export interface Decision {
  decision: "approve" | "request-changes";
  /** The review's comments: under a ticket's changes, or on the proposal as a whole. */
  comments: ReviewComment[];
  /** Recorded server-side at the decision POST — never taken from the payload. */
  provenance?: { decidedAt: string; decideMs: number; userAgent: string | null };
}

export interface ReviewOutcome {
  status: "pushed" | "changes-requested" | "stale";
  comments: ReviewComment[];
  pushFailure: string | null;
  /** Keys Jira assigned to the tickets this push created, by their @name. */
  created?: Record<string, string>;
}

export interface ApplyOptions {
  verdict?: AutoVerdict;
  /** The proposal's title, for the journal. */
  title?: string;
  /** Where progress goes; the terminal unless the caller collects it. */
  print?: Print;
  /** The caller has just checked staleness itself and will not have it checked twice. */
  stalenessChecked?: boolean;
}

/**
 * Act on the human's decision: record that this state of the proposal was reviewed,
 * then either hand back the notes (nothing sent) or send the whole changeset.
 */
export async function applyDecision(
  ctx: PushContext,
  compiled: CompiledPush,
  decision: Decision,
  opts: ApplyOptions = {},
): Promise<ReviewOutcome> {
  const { store } = ctx;
  const print: Print = opts.print ?? ((line) => console.log(line));

  const tipSeq = readChain(store).entries.at(-1)?.seq;
  if (tipSeq !== undefined) writeReviewMarker(store, tipSeq);

  const printComments = (label: string) => {
    for (const c of decision.comments) {
      print(`${label} ${c.on ? `on ${c.on}` : "on the proposal"} — ${JSON.stringify(c.body)}`);
    }
  };

  if (decision.decision === "request-changes") {
    print(red("changes requested — nothing was sent"));
    printComments(red("comment"));
    if (decision.comments.length === 0) {
      print(dim("(no comments were left — ask the user what to change)"));
    }
    return { status: "changes-requested", comments: decision.comments, pushFailure: null };
  }

  // Approved. The user may have taken minutes — re-check staleness before sending.
  // Atomic gate: any staleness aborts the whole push (nothing partial).
  if (!opts.stalenessChecked) {
    try {
      await checkStaleness(ctx, compiled.existingKeys);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      print(red(`not sent — ${e.message}`));
      return { status: "stale", comments: decision.comments, pushFailure: null };
    }
  }

  print("");
  const result = await executePush(ctx, compiled.ops, {
    review: decision.provenance,
    verdict: opts.verdict,
    title: opts.title,
  }, print);
  print("");
  const createdNote = result.refMap.size
    ? ` · created: ${[...result.refMap.entries()].map(([r, k]) => `${r} → ${bold(k)}`).join(", ")}`
    : "";
  if (result.failure) {
    print(red(`push incomplete — ${result.okCount}/${compiled.ops.length} ops applied`));
    const left = leftoverNotice(store);
    if (left) print(left);
  } else {
    print(
      green(`approved and pushed ${compiled.ops.length} operation${compiled.ops.length === 1 ? "" : "s"}`) +
        createdNote,
    );
  }
  print(dim(`journal: ${result.journalPath}`));
  printComments(cyan("comment (fyi, left on an approved review)"));
  return {
    status: "pushed",
    comments: decision.comments,
    pushFailure: result.failure,
    created: Object.fromEntries(result.refMap),
  };
}

/**
 * The comments in a decision POST. The page sends `comments`; `notes` (per-ticket
 * text keyed by ticket) is what pages rendered by jt 0.6 and earlier send.
 */
export function parseComments(body: unknown): ReviewComment[] {
  const b = (body ?? {}) as { comments?: unknown; notes?: unknown };
  const out: ReviewComment[] = [];
  if (Array.isArray(b.comments)) {
    for (const c of b.comments as { on?: unknown; body?: unknown }[]) {
      if (typeof c?.body !== "string" || !c.body.trim()) continue;
      out.push({ ...(typeof c.on === "string" && c.on ? { on: c.on } : {}), body: c.body.trim() });
    }
  } else if (b.notes && typeof b.notes === "object") {
    for (const [on, text] of Object.entries(b.notes as Record<string, unknown>)) {
      if (typeof text === "string" && text.trim()) out.push({ on, body: text.trim() });
    }
  }
  return out;
}
