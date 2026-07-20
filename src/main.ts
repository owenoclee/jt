import { cmdConfigShow, cmdInit } from "./commands/init.ts";
import { cmdMeta } from "./commands/meta.ts";
import { cmdFetch, cmdPull } from "./commands/fetch.ts";
import { cmdCommit } from "./commands/commit.ts";
import { cmdPush } from "./commands/push.ts";
import {
  cmdDiff,
  cmdLog,
  cmdNew,
  cmdResolve,
  cmdRestore,
  cmdRm,
  cmdSchema,
  cmdShow,
  cmdStatus,
  cmdUncommit,
  cmdUntrack,
} from "./commands/local.ts";
import { UserError } from "./errors.ts";
import { JiraApiError } from "./jira/client.ts";
import { bold, red } from "./render/colors.ts";

const USAGE = `${bold("jt")} — Jira tickets as local files (fetch → edit → diff → commit → push)

  workspace
    jt init --base-url URL --email EMAIL --project KEY [--board ID]
    jt config show          show config and token source
    jt meta sync            build .jira/meta.json (fields, types, sprints, statuses...)
    jt meta show            render the alias maps

  read (local-safe)
    jt fetch KEY... | --jql '...' [--limit N]
    jt pull                 refresh all tracked tickets; 3-way rebase, conflicts flagged
    jt status               working vs committed vs base, per ticket
    jt diff [ID...]         uncommitted changes (working vs committed/base)
    jt diff --committed     what push will send (committed vs base)
    jt diff --web           render the diff as a PR-style page (prints path; --open)
    jt show ID [--base|--committed]
    jt show --web [ID...]   read-only workspace browser: rendered ticket cards
    jt log [--all]          push journal

  write (local-safe)
    jt new NAME [--type T] [--summary S] [--parent KEY|@name]
    jt commit [ID...] [-m 'note']   stage working state into the changeset
    jt uncommit ID...       unstage (keep working edits)     [git restore --staged]
    jt restore ID...        reset working file to committed/base; undoes jt rm
    jt rm KEY               stage remote deletion   ·   jt untrack ID  drop locally
    jt resolve KEY          accept working file as desired state after a pull conflict

  push (the only remote-mutating verb)
    jt push [--dry-run]     compile committed−base → print exact API ops → execute → journal
    jt push --await-user [--timeout SECS] [--open]
                            serve the changeset as a browser review page. ONE decision:
                            Approve & push (whole changeset) or Request changes (nothing
                            sent; per-ticket notes returned). Prints the URL — agent or
                            user opens it (--open to launch from jt itself).
                            exit 0 pushed · 2 changes requested · 1 timeout/stale

  agent docs: jt schema   (ticket file JSON Schema) · see SKILL.md
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = Deno.args;
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
      return await cmdPull();
    case "status":
      return cmdStatus();
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
    case "untrack":
      return cmdUntrack(rest);
    case "resolve":
      return await cmdResolve(rest);
    case "push":
      return await cmdPush(rest);
    case "log":
      return cmdLog(rest);
    case "schema":
      return cmdSchema();
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
    await main();
  } catch (e) {
    if (e instanceof UserError || e instanceof JiraApiError) {
      console.error(red(`error: ${e.message}`));
      Deno.exit(1);
    }
    throw e;
  }
}
