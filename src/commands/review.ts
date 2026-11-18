/**
 * jt await and jt cancel — the author's side of a review.
 *
 * Neither is part of submitting a proposal: `jt push` is, and then the author is done.
 * `jt await` is for the occasions an agent is asked to wait — it blocks until the
 * proposal leaves review and says what became of it, as often as it is asked (the
 * outcome lives on disk, not in whoever collected it first). `jt cancel` withdraws a
 * proposal from review; the staged work stays.
 *
 * Exit status of jt await: 0 pushed · 2 changes requested (comments on stdout) ·
 * 1 anything else, including "still in review" when the wait runs out.
 */
import { parseArgs } from "@std/cli";
import { localContext } from "../context.ts";
import { fail } from "../errors.ts";
import { pidAlive } from "../process.ts";
import { DEFAULT_PROPOSAL, explicitProposalFlag, leftoverAdvice, proposalFlag } from "../proposal.ts";
import { makeRefContext } from "../refs.ts";
import { dim, green, red, yellow } from "../render/colors.ts";
import { renderJournalEntry } from "../render/render.ts";
import {
  clearPending,
  clearResult,
  legacyExitCode,
  type PushResultFile,
  pushLogPath,
  readPending,
  readResult,
} from "../review/legacy.ts";
import { awaitingDecision, proposalView } from "../review/meta.ts";
import { readRegistry } from "../review/registry.ts";
import type { Store } from "../store.ts";
import type { Config, ReviewComment } from "../types.ts";
import { proposalUrl, reviewOrigin } from "./serve.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long after a push `jt await` still reports it when nothing is in review. */
const RECENT_PUSH_MS = 7 * 24 * 60 * 60 * 1000;

export interface AwaitOutcome {
  code: number;
  lines: string[];
}

/** Review comments as an agent reads them: where each was made, and what it says. */
export function commentLines(comments: ReviewComment[]): string[] {
  return comments.map((c) =>
    `  comment ${c.on ? `on ${c.on}` : "on the proposal"}: ${JSON.stringify(c.body)}`
  );
}

/** The proposal's review link, when the server's whereabouts are known. */
export function linkFor(store: Store): string | null {
  const origin = reviewOrigin();
  const slug = readRegistry().find((e) => e.root === store.root)?.slug;
  return origin && slug ? proposalUrl(origin, slug, store.proposal) : null;
}

/**
 * Wait until the proposal is no longer in review (or `timeoutMs` passes), then say
 * what state it is in. Reads only; safe to run any number of times.
 */
export async function awaitOutcome(
  store: Store,
  config: Config,
  timeoutMs: number,
): Promise<AwaitOutcome> {
  const flag = proposalFlag(store.proposal);
  const lines: string[] = [];
  let view = proposalView(store);
  // What "it was pushed" has to be newer than, to be the answer to THIS wait.
  const since = view.meta?.submittedAt ?? null;
  const waited = awaitingDecision(view.status);
  if (waited) {
    const link = linkFor(store);
    console.log(dim(`waiting on the review${link ? ` at ${link}` : ""} ...`));
    const deadline = Date.now() + timeoutMs;
    while (awaitingDecision(view.status) && Date.now() < deadline) {
      await sleep(200);
      view = proposalView(store);
    }
    if (awaitingDecision(view.status)) {
      return {
        code: 1,
        lines: [
          `still in review — the user has not decided yet. Nothing is lost by not waiting: ` +
          `jt proposals shows the outcome later, and jt await${flag} waits again.`,
        ],
      };
    }
  }

  const pushed = () => {
    const record = store.lastPushRecord();
    if (!record) return false;
    lines.push(renderJournalEntry(record.path, record.entry, { refs: makeRefContext(store, config) }));
    return true;
  };

  switch (view.status) {
    case "empty": {
      const last = store.lastPush();
      // The answer to this wait is a push made since it was submitted. Asked with
      // nothing in review, a recent push is still worth reporting — an old one is not
      // news, and would read as the outcome of work that was never submitted.
      const cutoff = waited && since !== null
        ? since
        : new Date(Date.now() - RECENT_PUSH_MS).toISOString();
      if (last && last.startedAt >= cutoff) {
        const how = last.autoApproved ? "sent without review under the user's settings" : "approved and pushed";
        lines.unshift(
          last.result === "success"
            ? green(`${how}${waited ? "" : ` on ${last.startedAt.slice(0, 10)}`}`)
            : red(`${last.autoApproved ? "sent without review" : "approved"}, but the push stopped at a failure`),
        );
        pushed();
        return { code: last.result === "success" ? 0 : 1, lines };
      }
      if (waited) {
        return {
          code: 1,
          lines: [
            "the proposal closed without anything being sent — Jira already had every " +
            "change in it, or it was emptied",
          ],
        };
      }
      fail(
        `nothing to await${inProposal(store)} — nothing is staged or in review there` +
          proposalsElsewhere(store),
      );
      break;
    }
    case "changes-requested": {
      const comments = view.meta?.review?.comments ?? [];
      lines.push(red("changes requested — nothing was sent"));
      lines.push(...commentLines(comments));
      lines.push(
        dim(`address the comments, jt commit${flag} the result, then jt push${flag} submits it again`),
      );
      return { code: 2, lines };
    }
    case "partly-pushed": {
      lines.push(red("approved, but the push stopped at a failure"));
      pushed();
      if (view.leftovers) {
        lines.push(`${yellow("still staged:")} ${view.leftovers.ids.join(", ")} — ` + leftoverAdvice(view.leftovers.ids, flag));
      }
      return { code: 1, lines };
    }
    case "blocked":
      lines.push(red("not reviewable — it needs you before the user can decide:"));
      lines.push(...(view.meta?.blocked?.reason ?? "").split("\n").map((l) => `  ${l}`));
      return { code: 1, lines };
    case "revising":
      lines.push(
        `the staged work changed after it was submitted, so it is not in review — ` +
          `jt push${flag} submits it again`,
      );
      return { code: 1, lines };
    case "interrupted":
      lines.push(
        red("the review server stopped while sending this approved push") +
          ` — part of it may have reached Jira. Run jt pull and jt log, then jt push${flag} ` +
          `to submit what is left.`,
      );
      return { code: 1, lines };
    case "draft":
      if (waited) return { code: 1, lines: ["withdrawn from review — nothing was sent"] };
      fail(`nothing to await${inProposal(store)} — it is staged but not submitted (jt push${flag})`);
  }
  return { code: 1, lines };
}

/** jt await — block until the proposal leaves review, then report what became of it. */
export async function cmdAwait(argv: string[]): Promise<void> {
  const args = parseArgs(argv, { string: ["timeout"] });
  const ctx = localContext();
  const { store } = ctx;
  const timeoutMs = args.timeout ? Number(args.timeout) * 1000 : 600_000;
  if (readPending(store.proposalDir) || readResult(store.proposalDir)) {
    return await legacyAwait(store, timeoutMs);
  }
  const outcome = await awaitOutcome(store, ctx.ws.config, timeoutMs);
  for (const line of outcome.lines) console.log(line);
  if (outcome.code !== 0) Deno.exit(outcome.code);
}

/** jt cancel — withdraw the proposal from review. Nothing is sent; staged work stays. */
export async function cmdCancel(): Promise<void> {
  const { store } = localContext();
  const flag = proposalFlag(store.proposal);
  if (readPending(store.proposalDir) || readResult(store.proposalDir)) return await legacyCancel(store);

  const view = proposalView(store);
  const meta = view.meta;
  switch (view.status) {
    case "in-review":
    case "revising":
    case "blocked":
      store.writeMeta({
        title: meta!.title,
        description: meta!.description,
        ...(meta!.previousReview ? { previousReview: meta!.previousReview } : {}),
      });
      console.log(
        `withdrawn from review — nothing was sent. The staged work is kept: ` +
          `jt push${flag} submits it again, jt uncommit${flag} unstages it.`,
      );
      return;
    case "interrupted":
      store.writeMeta({ title: meta!.title, description: meta!.description });
      store.dropIfDrained();
      console.log("cleared the interrupted push — jt pull and jt log show what reached Jira");
      return;
    case "pushing":
      fail(`too late to cancel — the user approved it and it is being sent; jt await${flag} reports the outcome`);
      break;
    case "changes-requested":
      fail(
        `nothing to cancel — the user asked for changes, so it is not in review ` +
          `(jt proposals shows their comments)`,
      );
      break;
    default:
      fail(`nothing to cancel — no review is open${inProposal(store)}${proposalsElsewhere(store)}`);
  }
}

function inProposal(store: Store): string {
  return store.proposal === DEFAULT_PROPOSAL ? "" : ` in proposal '${store.proposal}'`;
}

/**
 * An agent that forgot its -p would otherwise be told there is nothing here while its
 * proposal sits under another name — so name the ones that exist.
 */
function proposalsElsewhere(store: Store): string {
  const lines: string[] = [];
  for (const name of store.listProposals()) {
    if (name === store.proposal) continue;
    const view = proposalView(store.scoped(name));
    if (view.status === "empty" || view.status === "draft") continue;
    lines.push(`  ${name}: ${view.status.replace("-", " ")} — jt await${explicitProposalFlag(name)}`);
  }
  return lines.length ? `\nproposals with a review under way:\n${lines.join("\n")}` : "";
}

// ---- reviews opened by jt 0.6 and earlier (see src/review/legacy.ts) ----

async function legacyAwait(store: Store, timeoutMs: number): Promise<void> {
  const dir = store.proposalDir;
  const flag = proposalFlag(store.proposal);
  let result: PushResultFile | null = readResult(dir);
  if (!result) {
    const pending = readPending(dir);
    // The old server wrote its outcome BEFORE removing the pending file, so "no
    // outcome, then no pending review" can also mean the review settled between those
    // two reads. Look for the outcome once more before concluding there is nothing.
    if (!pending) result = readResult(dir);
    if (!pending && !result) fail(`nothing to await${inProposal(store)}`);
    if (pending) console.log(dim(`waiting on the review at ${pending.url} (opened by an older jt) ...`));
    const deadline = Date.now() + timeoutMs;
    while (pending && !result && Date.now() < deadline) {
      await sleep(250);
      result = readResult(dir);
      if (!result && !pidAlive(pending.pid)) {
        await sleep(500); // the server may exit between writing the result and our probe
        result = readResult(dir);
        if (!result) {
          clearPending(dir);
          fail(
            `the review server is gone without recording an outcome — see ${pushLogPath(dir)} ` +
              `and jt log; jt push${flag} submits the proposal again`,
          );
        }
      }
    }
    if (!result) {
      fail(
        `gave up waiting — the review page is still live; run jt await${flag} again ` +
          `(or jt cancel${flag} to withdraw the review)`,
      );
    }
  }
  clearResult(dir);
  store.dropIfDrained();
  for (const line of result.log) console.log(line);
  const code = legacyExitCode(result);
  if (code !== 0) Deno.exit(code);
}

async function legacyCancel(store: Store): Promise<void> {
  const dir = store.proposalDir;
  const pending = readPending(dir);
  if (!pending) {
    fail("nothing to cancel — the review already settled; run jt await to collect its outcome");
  }
  if (pending.decidedAt) {
    fail("too late to cancel — the review was already decided; jt await reports the outcome");
  }
  if (pidAlive(pending.pid)) {
    try {
      Deno.kill(pending.pid, "SIGTERM");
    } catch {
      // exited between the liveness probe and the signal
    }
    const deadline = Date.now() + 10_000;
    while (pidAlive(pending.pid) && Date.now() < deadline) {
      await sleep(100);
      if (readPending(dir)?.decidedAt) {
        fail("too late to cancel — the review was decided first; jt await reports the outcome");
      }
    }
    if (pidAlive(pending.pid)) {
      fail(
        `the review server (pid ${pending.pid}) is still running — ` +
          `it may be executing a decision; run jt await`,
      );
    }
  }
  const result = readResult(dir);
  if (result && result.status !== "cancelled") {
    fail("too late to cancel — the review already settled; run jt await to collect its outcome");
  }
  if (result) clearResult(dir); // the old server's own cancellation record — collected here
  clearPending(dir);
  store.dropIfDrained();
  console.log("review cancelled — nothing was sent");
}
