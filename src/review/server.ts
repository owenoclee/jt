/**
 * The --await-user review flow: serve the changeset as a PR-style page on loopback,
 * wait for the human's single decision — Approve & push (the WHOLE changeset) or
 * Request changes (nothing sent; per-ticket notes return to the agent) — then act.
 * The reviewing process and the sending process are the same process, and an approved
 * page is sent whole: what you saw is exactly what ships, as a unit.
 */
import { readChain, writeReviewMarker } from "../chain.ts";
import { checkStaleness, executePush, type PushContext } from "../commands/push.ts";
import type { CompiledPush } from "../compile.ts";
import { UserError } from "../errors.ts";
import { bold, cyan, dim, green, red, yellow } from "../render/colors.ts";
import { renderPage, type ReviewPageModel } from "./html.ts";
import { buildPageModel } from "./model.ts";
import { buildTicketPlans } from "./plan.ts";

export interface ReviewOptions {
  timeoutMs: number;
  /**
   * Launch the OS browser opener from this process (--open). Default false: printing
   * the URL is the contract — sandboxed agent shells can't open GUI apps, so the
   * agent (or user) opens the printed URL instead. See SKILL.md.
   */
  openBrowser?: boolean;
  port?: number;
  /** Test hook: called with the review URL once the server is listening. */
  onServe?: (url: string) => void;
}

export interface Decision {
  decision: "approve" | "request-changes";
  notes: Record<string, string>;
}

export interface ReviewOutcome {
  status: "pushed" | "changes-requested" | "timeout" | "stale";
  notes: Record<string, string>;
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
  const decision = await serveAndAwait(model, opts);

  if (decision === null) {
    console.log(red("review timed out — nothing was sent"));
    return { status: "timeout", notes: {}, pushFailure: null };
  }

  const tipSeq = readChain(store).entries.at(-1)?.seq;
  if (tipSeq !== undefined) writeReviewMarker(store, tipSeq);

  const printNotes = (label: string) => {
    for (const [id, note] of Object.entries(decision.notes)) {
      console.log(`${label} ${id} — ${JSON.stringify(note)}`);
    }
  };

  if (decision.decision === "request-changes") {
    console.log(red("changes requested — nothing was sent"));
    printNotes(red("note:"));
    if (Object.keys(decision.notes).length === 0) {
      console.log(dim("(no notes were left — ask the user what to change)"));
    }
    return { status: "changes-requested", notes: decision.notes, pushFailure: null };
  }

  // Approved. The user may have taken minutes — re-check staleness before sending.
  // Atomic gate: any staleness aborts the whole push (nothing partial).
  try {
    await checkStaleness(ctx, compiled.existingKeys);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    console.log(red(`not sent — ${e.message}`));
    return { status: "stale", notes: decision.notes, pushFailure: null };
  }

  console.log("");
  const result = await executePush(ctx, compiled.ops);
  console.log("");
  const createdNote = result.refMap.size
    ? ` · created: ${[...result.refMap.entries()].map(([r, k]) => `${r} → ${bold(k)}`).join(", ")}`
    : "";
  if (result.failure) {
    console.log(red(`push incomplete — ${result.okCount}/${compiled.ops.length} ops applied`));
  } else {
    console.log(
      green(`approved and pushed ${compiled.ops.length} operation${compiled.ops.length === 1 ? "" : "s"}`) +
        createdNote,
    );
  }
  console.log(dim(`journal: ${result.journalPath}`));
  printNotes(cyan("note (fyi, left on an approved review):"));
  return { status: "pushed", notes: decision.notes, pushFailure: result.failure };
}

/** Serve the page on loopback and wait for one decision POST (or timeout). */
async function serveAndAwait(
  model: ReviewPageModel,
  opts: ReviewOptions,
): Promise<Decision | null> {
  let resolveDecision!: (d: Decision) => void;
  const decided = new Promise<Decision>((r) => (resolveDecision = r));
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
          if (body?.decision !== "approve" && body?.decision !== "request-changes") {
            throw new Error("bad payload");
          }
          const notes = body.notes && typeof body.notes === "object" ? body.notes : {};
          done = true;
          resolveDecision({ decision: body.decision, notes });
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
  console.log(dim("open this URL in a browser to decide — waiting..."));
  opts.onServe?.(reviewUrl);
  if (opts.openBrowser) openInBrowser(reviewUrl);

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
