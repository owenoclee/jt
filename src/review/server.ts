/**
 * The --await-user review flow: serve the changeset as a PR-style page on loopback,
 * wait for per-ticket decisions from the human, then execute exactly the approved
 * subset. The reviewing process and the sending process are the same process — there
 * is no approve-then-push-later window.
 */
import { readChain, writeReviewMarker } from "../chain.ts";
import { checkStaleness, executePush, type PushContext } from "../commands/push.ts";
import type { CompiledPush } from "../compile.ts";
import { UserError } from "../errors.ts";
import { bold, cyan, dim, green, red, yellow } from "../render/colors.ts";
import { renderPage, type ReviewPageModel } from "./html.ts";
import { buildPageModel } from "./model.ts";
import { buildTicketPlans, filterOpsForApproved } from "./plan.ts";

export interface ReviewOptions {
  timeoutMs: number;
  openBrowser?: boolean;
  port?: number;
  /** Test hook: called with the review URL once the server is listening. */
  onServe?: (url: string) => void;
}

export type Decisions = Record<string, { approve: boolean; note: string }>;

export interface ReviewOutcome {
  status: "pushed" | "partial" | "all-rejected" | "timeout";
  approved: string[];
  rejected: { id: string; note: string }[];
  droppedForDeps: { id: string; reason: string }[];
  droppedStale: string[];
  pushFailure: string | null;
}

export async function runReviewFlow(
  ctx: PushContext,
  compiled: CompiledPush,
  opts: ReviewOptions,
): Promise<ReviewOutcome> {
  const { store } = ctx;
  const plans = buildTicketPlans(store, compiled.ops);
  const model = buildPageModel(store, ctx.ws.config, plans, opts.timeoutMs);

  for (const w of compiled.warnings) console.log(`${yellow("warning:")} ${w}`);
  const decisions = await serveAndAwait(model, opts);

  if (decisions === null) {
    console.log(red("review timed out — nothing was sent"));
    return {
      status: "timeout",
      approved: [],
      rejected: [],
      droppedForDeps: [],
      droppedStale: [],
      pushFailure: null,
    };
  }

  const tipSeq = readChain(store).entries.at(-1)?.seq;
  if (tipSeq !== undefined) writeReviewMarker(store, tipSeq);

  const approvedIds = plans.filter((p) => decisions[p.id]?.approve).map((p) => p.id);
  const rejected = plans
    .filter((p) => !decisions[p.id]?.approve)
    .map((p) => ({ id: p.id, note: decisions[p.id]?.note ?? "" }));

  const filtered = filterOpsForApproved(plans, compiled.ops, approvedIds);

  // The user may have taken minutes — re-check staleness for what's about to ship.
  const staleDropped: string[] = [];
  const approvedExisting = filtered.approved.filter((id) => !id.startsWith("@"));
  try {
    await checkStaleness(ctx, approvedExisting);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    staleDropped.push(...approvedExisting.filter((id) => e.message.includes(id)));
  }
  const finalApproved = filtered.approved.filter((id) => !staleDropped.includes(id));
  const finalOps = filtered.ops.filter((op) => finalApproved.includes(op.issue));

  let pushFailure: string | null = null;
  if (finalOps.length > 0) {
    console.log("");
    const result = await executePush(ctx, finalOps);
    pushFailure = result.failure;
    console.log("");
    const createdNote = result.refMap.size
      ? ` · created: ${[...result.refMap.entries()].map(([r, k]) => `${r} → ${bold(k)}`).join(", ")}`
      : "";
    if (pushFailure) {
      console.log(red(`push incomplete — ${result.okCount}/${finalOps.length} ops applied`));
    } else {
      console.log(green(`pushed: ${finalApproved.join(", ")}`) + createdNote);
    }
    console.log(dim(`journal: ${result.journalPath}`));
  } else {
    console.log(cyan("nothing approved — nothing was sent"));
  }

  for (const r of rejected) {
    console.log(`${red("rejected:")} ${r.id}${r.note ? ` — ${JSON.stringify(r.note)}` : ""}`);
  }
  for (const d of filtered.dropped) {
    console.log(`${yellow("not sent:")} ${d.id} — ${d.reason} (approve them together)`);
  }
  for (const s of staleDropped) {
    console.log(`${yellow("not sent:")} ${s} — remote changed while you reviewed; run jt pull`);
  }

  const status = rejected.length === 0 && filtered.dropped.length === 0 && staleDropped.length === 0
    ? "pushed"
    : finalApproved.length > 0
    ? "partial"
    : "all-rejected";
  return {
    status,
    approved: finalApproved,
    rejected,
    droppedForDeps: filtered.dropped,
    droppedStale: staleDropped,
    pushFailure,
  };
}

/** Serve the page on loopback and wait for one decision POST (or timeout). */
async function serveAndAwait(
  model: ReviewPageModel,
  opts: ReviewOptions,
): Promise<Decisions | null> {
  let resolveDecision!: (d: Decisions) => void;
  const decided = new Promise<Decisions>((r) => (resolveDecision = r));
  let done = false;

  const html = renderPage(model);
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: opts.port ?? 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === `/review/${model.nonce}`) {
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (req.method === "POST" && url.pathname === `/decide/${model.nonce}` && !done) {
        try {
          const body = await req.json();
          const decisions = body?.decisions;
          if (!decisions || typeof decisions !== "object") throw new Error("bad payload");
          done = true;
          resolveDecision(decisions as Decisions);
          return Response.json({ ok: true });
        } catch {
          return Response.json({ ok: false }, { status: 400 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  );

  const addr = server.addr as Deno.NetAddr;
  const reviewUrl = `http://127.0.0.1:${addr.port}/review/${model.nonce}`;
  console.log(`${bold("review page:")} ${reviewUrl}`);
  console.log(dim("waiting for your decision in the browser..."));
  opts.onServe?.(reviewUrl);
  if (opts.openBrowser !== false) openInBrowser(reviewUrl);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), opts.timeoutMs);
  });
  const result = await Promise.race([decided, timeout]);
  clearTimeout(timer);
  await server.shutdown();
  return result;
}

function openInBrowser(url: string): void {
  const cmd = Deno.build.os === "darwin" ? "open" : "xdg-open";
  try {
    new Deno.Command(cmd, { args: [url], stdout: "null", stderr: "null" }).spawn().unref();
  } catch {
    // URL was printed; the user can open it manually.
  }
}
