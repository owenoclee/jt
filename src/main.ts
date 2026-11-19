import { cmdConfigShow, cmdInit } from "./commands/init.ts";
import { cmdMeta } from "./commands/meta.ts";
import { cmdSkill } from "./commands/skill.ts";
import { cmdChanges } from "./commands/changes.ts";
import { cmdFetch, cmdPull } from "./commands/fetch.ts";
import { cmdCommit } from "./commands/commit.ts";
import { cmdPush } from "./commands/push.ts";
import { cmdAwait, cmdCancel } from "./commands/review.ts";
import { cmdReview, cmdServe, reviveServerIfNeeded } from "./commands/serve.ts";
import { cmdLog } from "./commands/log.ts";
import { cmdProposals } from "./commands/proposals.ts";
import {
  cmdArchive,
  cmdDiff,
  cmdNew,
  cmdResolve,
  cmdRestore,
  cmdRm,
  cmdSchema,
  cmdShow,
  cmdStatus,
  cmdUnarchive,
  cmdUncommit,
  cmdUntrack,
} from "./commands/local.ts";
import { findWorkspaceRoot } from "./config.ts";
import { UserError } from "./errors.ts";
import { JiraApiError } from "./jira/client.ts";
import { withWorkspaceLock } from "./lock.ts";
import { extractProposalFlag, setActiveProposal } from "./proposal.ts";
import { bold, red } from "./render/colors.ts";
import { skillSyncEnabled, syncInstalledSkills } from "./skillsync.ts";
import { startUpdateCheck, updateCheckEnabled } from "./update.ts";
import { VERSION } from "./version.ts";

export { VERSION };

const USAGE = `${bold("jt")} — Jira tickets as local files (fetch → edit → diff → commit → push)

  workspace
    jt init --base-url URL --email EMAIL --project KEY [--board ID]
    jt config show          show config, token source, and the user's auto-allow rules
    jt meta sync            build .jira/meta.json (fields, types, sprints, statuses...)
    jt meta show            render the alias maps

  read (local-safe)
    jt pull [--full]        sync the mirror (sync.jql in config): new, changed and deleted
                            tickets flow in; 3-way rebase, conflicts flagged
    jt changes [KEY...]     upstream edits since your last ack: new / changed / gone
                            (compact: description edits show as ±line counts — --full
                            prints the line diffs)
    jt changes --ack        absorb them — records current remote state as seen; prints
                            counts only, never reprints the diffs
    jt changes --web [--timeout SECS]
                            the same news as a glanceable page (purple = informational,
                            nothing sent); its Acknowledge button records the ack
    jt fetch KEY... | --jql '...' [--limit N]   track tickets one by one
    jt status [--all]       working vs committed vs base, per ticket (--all lists clean);
                            tickets staged in another proposal are tagged with its name
    jt diff [ID...]         uncommitted changes (working vs committed/base)
    jt diff --committed     what push will send (committed vs base)
    jt diff --web           render the diff as a PR-style page (prints the file path)
    jt show ID [--base|--committed]
    jt show --web [ID...]   read-only workspace browser: rendered ticket cards
    jt proposals            every proposal: what it has staged and where its review is

  history (everything jt sent to Jira from this workspace)
    jt log [KEY...] [--today | --since AGE|DATE] [--all] [--full] [--web]
                            one entry per push, newest first: how it was approved (on
                            the review page, or auto-allowed by the user's settings),
                            its proposal, and what changed on each ticket. --today /
                            --since 3d / --since 2026-10-01 pick a window; KEYs pick
                            tickets; --full adds description line diffs and every API
                            call; --web writes the same history as a page

  write (local-safe)
    jt new NAME [--type T] [--summary S] [--parent KEY|@name]
    jt commit [ID...] [-m 'note']   stage working state into the changeset
    jt uncommit ID...       unstage (keep working edits)     [git restore --staged]
    jt restore ID...        reset working file to committed/base; undoes rm/archive
    jt archive KEY          stage archiving (reversible; Jira Premium/Enterprise)
    jt unarchive KEY        stage un-archiving of an archived issue
    jt rm KEY               stage permanent deletion — prefer jt archive
    jt untrack ID...        remove all local state; Jira untouched
    jt resolve KEY          accept working file as desired state after a pull conflict

  proposals (one named changeset each, reviewed like a pull request)
    -p NAME | --proposal NAME | JT_PROPOSAL=NAME
                            a global flag for any command: commit, push, await, cancel,
                            uncommit, diff --committed... then act on proposal NAME only.
                            Each proposal has its own staged tickets, its own review
                            page at its own durable link, and its own outcome, so
                            agents sharing a workspace never touch each other's work.
                            A ticket is held by one proposal at a time. With no name,
                            commands use the default proposal. jt commit -p NAME takes
                            explicit ids (with none: new edits to tickets NAME holds)
    jt proposals [--json]   every proposal: what is staged, where its review stands,
                            the comments the user left when asking for changes, and
                            what was approved and pushed lately. Start here when
                            picking work back up. --json prints the same facts as one
                            JSON document, for a script rather than for you

  push (submit for review — the user's approval is what sends it to Jira)
    jt push [-p NAME] --title 'what it does' [--description MD | --description-file F]
                            compile committed−base and check it against Jira, then
                            submit the proposal for review and print its link. NOTHING
                            is sent, and nothing more is owed: give the user the link
                            and stop. They review it whenever they get to it — Approve
                            & push sends the WHOLE changeset exactly as rendered, with
                            no agent involved; Request changes sends nothing and leaves
                            their comments on the proposal (jt proposals). Running push
                            again resubmits: after addressing comments, or after any
                            change to a submitted proposal. A named proposal needs a
                            title; the description says why, for a reviewer reading it
                            later without you.
                            Exception: if EVERY change is one the user auto-allowed in
                            ~/.config/jt/settings.json, push sends it at once and says
                            so — no review. In a mixed changeset the auto-allowed
                            changes are greyed out on the page and wait with the rest
    jt push --dry-run       print the compiled API ops and stop (nothing submitted or
                            sent; ADF bodies elided — add --full for the raw JSON); says
                            which changes the user's settings auto-allow
    jt await [--timeout SECS]
                            optional — only when the user asks you to wait. Blocks until
                            the proposal leaves review and reports what became of it;
                            repeatable. exit 0 pushed · 2 changes requested (comments on
                            stdout) · 1 otherwise, including still-in-review after SECS
                            (default 600)
    jt cancel               withdraw the proposal from review: nothing is sent, the
                            staged work stays; refused once it has been approved

  review server (for the user)
    jt review               print where the proposals are (the inbox), starting the
                            review server if it is not running
    jt serve [--status | --stop]
                            run the review server in the foreground. jt starts it by
                            itself when a proposal is submitted; it serves every
                            workspace on 127.0.0.1:5472 ("reviewPort" in settings.json)

  agents
    jt skill install <claude-code|codex>
                            install the agent skill into the agent's skills directory
    jt skill show           print the agent skill (SKILL.md) to stdout — install
                            anywhere via a redirect
    jt schema               print the ticket file JSON Schema

  jt checks GitHub once a day for a newer release and prints a one-line notice when
  there is one. It never updates itself. JT_NO_UPDATE_CHECK=1 turns the check off.
`;

/**
 * Commands that rewrite the tool-owned layers. Each holds the workspace lock while it
 * runs, so it never interleaves with another agent's command or with the review server
 * settling an approved push. Reads, and anything that waits on a human, stay outside.
 */
const LOCKED_COMMANDS = new Set([
  "fetch",
  "pull",
  "new",
  "commit",
  "uncommit",
  "restore",
  "rm",
  "archive",
  "unarchive",
  "untrack",
  "resolve",
  "push",
  "cancel",
  "proposals",
]);

async function main(argv: string[]): Promise<void> {
  const root = argv[0] !== undefined && LOCKED_COMMANDS.has(argv[0])
    ? findWorkspaceRoot(Deno.cwd())
    : null;
  if (root) return await withWorkspaceLock(root, () => dispatch(argv));
  return await dispatch(argv);
}

async function dispatch(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":
      return cmdInit(rest);
    case "config":
      if (rest[0] === "show" || rest.length === 0) return cmdConfigShow();
      throw new UserError("usage: jt config show");
    case "meta":
      return await cmdMeta(rest);
    case "fetch":
      return await cmdFetch(rest);
    case "pull":
      return await cmdPull(rest);
    case "changes":
      return await cmdChanges(rest);
    case "status":
      return cmdStatus(rest);
    case "diff":
      return cmdDiff(rest);
    case "show":
      return cmdShow(rest);
    case "new":
      return cmdNew(rest);
    case "commit":
      return cmdCommit(rest);
    case "uncommit":
      return cmdUncommit(rest);
    case "restore":
      return cmdRestore(rest);
    case "rm":
      return cmdRm(rest);
    case "archive":
      return cmdArchive(rest);
    case "unarchive":
      return cmdUnarchive(rest);
    case "untrack":
      return cmdUntrack(rest);
    case "resolve":
      return await cmdResolve(rest);
    case "push":
      return await cmdPush(rest);
    case "await":
      return await cmdAwait(rest);
    case "cancel":
      return await cmdCancel();
    case "serve":
      return await cmdServe(rest);
    case "review":
      return await cmdReview();
    case "log":
      return cmdLog(rest);
    case "proposals":
      return cmdProposals(rest);
    case "skill":
      return cmdSkill(rest);
    case "schema":
      return cmdSchema();
    case "version":
    case "--version":
      console.log(`jt ${VERSION}`);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      return;
    default:
      throw new UserError(`unknown command 'jt ${cmd}' — run jt help`);
  }
}

if (import.meta.main) {
  try {
    // -p/--proposal is global: it scopes whichever command follows to one proposal.
    const { proposal, rest } = extractProposalFlag(Deno.args);
    if (proposal !== null) setActiveProposal(proposal);
    const advise = updateCheckEnabled(rest[0]) ? startUpdateCheck(rest[0]) : null;
    // Before the command, not after: a stale skill is most likely to show up as a failed
    // command, and an error (or jt await's own exit) would skip anything printed later.
    if (skillSyncEnabled(rest[0])) await syncInstalledSkills();
    await main(rest);
    // Links already handed out must keep working: bring the review server back if a
    // reboot took it away. push and review make sure of it themselves.
    if (!["serve", "review", "push", undefined].includes(rest[0]) && skillSyncEnabled(rest[0])) {
      reviveServerIfNeeded();
    }
    await advise?.();
  } catch (e) {
    if (e instanceof UserError || e instanceof JiraApiError) {
      console.error(red(`error: ${e.message}`));
      Deno.exit(1);
    }
    throw e;
  }
}
