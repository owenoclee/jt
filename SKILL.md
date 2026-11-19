---
name: jt
description: Manage Jira tickets with the jt CLI using local ticket files, computed diffs, and proposals the user reviews and approves like pull requests. Use for reading, searching, summarizing, creating, editing, linking, labeling, transitioning, commenting on, or deleting Jira tickets, assigning sprint work, reviewing board changes, or picking up a jt proposal the user has reviewed.
---

# jt agent contract

`jt` treats Jira like a remote VCS. Edit ticket files, inspect computed diffs, commit
the intended state, and submit it as a **proposal** — jt's pull request. You hand the
user its link and stop; they review it in a browser when they get to it, and their
approval is what sends it to Jira.

## Workspace discovery and setup

A directory is a `jt` workspace if it contains:

```text
.jira/config.json
```

Locate a workspace with two checks, in this order — run these exact commands rather
than improvising a search:

1. `jt config show` — it walks up from the current directory itself. If it prints a
   workspace, use that one (the nearest ancestor); if it errors, move to step 2.
2. `ls -d ~/jira/*/.jira/config.json` — each hit is a workspace exactly one directory
   under the conventional durable location `~/jira/` (for example `~/jira/SBX`). Pick
   the one whose config matches the project and confirm with the user. The config file
   always sits at `<workspace>/.jira/config.json`, so a recursive or depth-limited
   `find` is never needed — and depth-limited variants have wrongly concluded that no
   workspace exists.

If no workspace exists, propose creating `~/jira/<PROJECT_KEY>/` and ask for confirmation
before creating that directory or initializing it.

A `.jira/config.json` that is malformed or points to the wrong project is a setup problem:
report it rather than silently creating a second workspace elsewhere.

To initialize a new workspace, obtain any missing values:

- Jira site or board URL. A pasted board URL is acceptable; derive the base URL, project
  key, and board ID when possible.
- Jira account email, if it is not already known.
- Project key, if it cannot be derived from the URL.

After initialization, run `jt meta sync` and `jt meta show`. Inspect the available issue
types, statuses, priorities, sprints, and custom fields. Present the user with a concise
selection of custom fields to track; configure only fields the user explicitly selects.
Do not configure dozens of custom fields by default, it is likely the user only cares
about a small subset of possible fields.

The default workspace mirrors the project's `sync.jql`:

```sh
jt pull
jt changes
jt status
```

`jt pull` synchronizes Jira and rebases non-overlapping remote edits. `jt changes`
reports remote changes since the last acknowledgment, compactly: description edits
appear as ±line counts (`jt changes --full` prints the line diffs when they matter).
Surface non-empty output to the user; run `jt changes --ack` only after it has been
seen or handled — it records the ack and prints counts only, without repeating the
diffs. Changes the user approved on a proposal's page are recorded as seen
automatically and do not reappear here.

Use `jt fetch KEY...` when tracking individual tickets rather than a mirror.

## Change workflow

```sh
jt proposals                 # what is already open, and what the user asked for
jt fetch PROJ-123
# edit tickets/PROJ-123.json
jt diff PROJ-123
jt commit -p fix-login PROJ-123 -m "explain the change"
jt push -p fix-login --title "Tighten the login ticket's acceptance criteria" \
  --description "Why, in markdown — for a reviewer reading this later, without you."
# prints the proposal's link: give it to the user. Your part is done.
```

`jt push` **submits a proposal for review**. It sends nothing. It:

1. Compiles committed state, never the working files.
2. Checks that Jira has not changed since the last fetch.
3. Records the proposal as submitted and prints its link — a durable page on the
   user's own machine, `http://127.0.0.1:5472/p/<workspace>/<proposal>`.
4. The entire changeset is sent when the user selects **Approve & push** on that
   page: whenever they get to it, and with no agent involved.

One outcome skips the review. The user can auto-allow kinds of change in their own
settings (see "Auto-allowed changes"); when *every* change in the push is one of those,
`jt push` sends it then and there and prints `auto-allowed ... DONE — there is no review
page and nothing to await`. Read what push printed: a `submitted for review:` line means
a proposal is waiting for the user; the auto-allowed line means the changes are in Jira.

### Submitting is the end of your part

A submitted proposal is a pull request waiting for its reviewer. Once `jt push` prints
the link:

- **Give the user the link** in your reply, with a sentence or two on what the proposal
  changes. Say it is *submitted for review* — never that it was pushed, is done, or is
  in Jira.
- **Then stop.** You may finish your turn, or carry on with other work you were asked
  for. The user reviews it when they get to it; that may be days later.
- **Do not open the link for them** (`open`, `xdg-open`), and never fetch the page,
  inspect it, or drive it with browser automation. The decision on it is the human's.
- **Do not wait on the review.** Approval sends the changes without you. Only if the
  user asks you to wait for their decision, run `jt await -p NAME`: it blocks until the
  proposal leaves review (600 seconds by default; `--timeout SECS`) and exits `0`
  pushed, `2` changes requested (their comments on stdout), `1` otherwise. "Still in
  review" when the wait runs out is not a failure and loses nothing.

**The title and description are all the reviewer has.** They read the proposal later,
in a list with others, without this conversation. `--title` says what it does in one
line and is required for a named proposal. `--description` says why: what you were
asked, what you decided, what they should check. It is markdown; use
`--description-file FILE` for anything longer than a line.

On the page the user can:

- **Approve & push** — the whole changeset is sent, exactly as shown.
- **Request changes** — nothing is sent. They leave comments, as on a pull request:
  under a particular ticket's changes, or on the proposal as a whole. The comments are
  saved on the proposal for whichever agent picks it up.

Opening the page checks the proposal against Jira. Edits other people made to fields
the proposal leaves alone are absorbed without anyone's help. If Jira changed a field
the proposal also changes, or a staged ticket is gone, the proposal is marked as needing
its agent and cannot be approved until that is fixed (see below).

A push sends its operations in order and stops at the first one Jira refuses. Whatever
was already sent stays done. The rest stays staged in its proposal, and `jt status` and
`jt proposals` mark it as left over from that push. That is not new work: the user
approved it, and it never arrived. Show the user what failed (`jt log KEY`). Whether to
fix it and push again or drop it with `jt uncommit` is their decision, including when
you find leftovers from an earlier session.

`jt push --dry-run` prints the compiled operations without submitting or sending, and
says which changes the user's settings auto-allow.

## Picking work back up

Reviews happen while nobody is waiting, so nobody is told the outcome: you look. Run
`jt proposals` at the start of any jt task, and whenever the user mentions a proposal,
a review, or work "from earlier". It lists every proposal with its state, its link,
the user's review comments, and what was approved and pushed in the last week.
(`jt status` also flags a proposal that needs an agent.) What each state asks of you:

- **in review** — the user's move. Nothing to do; pushing again does not hurry it.
- **changes requested** — the comments are your brief. Address each one (edit,
  `jt commit -p NAME ...`), then `jt push -p NAME` to submit it again; the title and
  description are kept unless you pass new ones. If a comment is unclear, ask the user
  rather than guessing. A proposal from an earlier session or another agent is yours to
  continue only when the user asks you to.
- **changed since it was submitted** — its staged work was changed after `jt push`, so
  what the user would be reviewing is no longer what was submitted. It cannot be
  approved until `jt push -p NAME` submits it again. Every command that changes a
  submitted proposal (commit, uncommit, restore, rm, archive, untrack, resolve) does
  this, and says so.
- **not reviewable** — it names what is wrong: usually `jt pull`, settle the conflict
  it describes, recommit, then `jt push -p NAME` again.
- **partly pushed** — leftovers from a push that stopped at a failure (above).
- **approved and pushed** — it is in Jira. Tell the user if they have not heard, with
  the keys of any tickets it created.

`jt cancel -p NAME` withdraws a proposal from review without sending anything; the
staged work stays. Use it when the user asks you to drop or rework a proposal. It is
refused once the proposal has been approved.

## Proposals: one named changeset each

Every staged change belongs to a **proposal** — a named changeset with its own commits,
its own link, and its own outcome. **Name yours**, and pass the same name to every
command:

```sh
jt commit -p auth-cleanup PROJ-12 PROJ-15 -m "tighten session handling"
jt push   -p auth-cleanup --title "Tighten session handling" --description "..."
```

A proposal may wait days for its review while you, later sessions and other agents
stage other work in the same workspace, so a shared unnamed changeset is rarely what
you want. Commands that name none use the default proposal, which is fine for a single
quick change when `jt proposals` shows nothing else open.

Pick a short name for the task (`auth-cleanup`, `q3-epics`): lowercase letters, digits,
dashes. `--proposal NAME` and `JT_PROPOSAL=NAME` mean the same as `-p NAME`. There is no
command to "switch" proposal — the name is given each time, so no agent can change it
under another.

- **Always give `jt commit -p NAME` explicit ids.** The working tree is shared, so other
  agents' unfinished edits show as modified too; with a name and no ids, commit takes
  only new edits to tickets your proposal already holds.
- **One proposal per ticket.** If commit, restore, untrack, rm or archive reports that a
  ticket `is staged in proposal 'x'`, another proposal holds it. Do not release it
  yourself with `-p x`; leave the ticket alone or ask the user.
- Use the same `-p NAME` for `jt push`, `jt await`, `jt cancel`, `jt uncommit`, and
  `jt diff --committed`. An await or cancel that names the wrong proposal finds nothing
  and lists the proposals that exist.
- `jt status` shows the whole workspace; rows tagged `[proposal x]` are staged elsewhere.
- Do not edit a ticket file another proposal holds. `jt pull` is safe to run at any
  time — it rebases every proposal's staged tickets.

Any number of proposals can be in review at once. Keep each one to a change the user
can judge as a unit: they approve or send back a proposal whole.

## Auto-allowed changes

The user may keep a settings file, `~/.config/jt/settings.json`, listing kinds of change
that need no review — typically assignee changes, status transitions, and comments.
`jt config show` prints the rules in force. Two consequences:

- A push made **only** of auto-allowed changes is sent by `jt push` itself (see above).
  Report it as done, saying it was auto-allowed and what it changed.
- A push that **mixes** them with anything else is submitted for review whole; the
  auto-allowed changes are shown greyed out and are sent only if the user approves.
  Nothing is sent early.

That file is the user's decision about what you may do unsupervised. **Never create,
edit, or suggest edits to it on your own initiative**, and never restructure work to route
around a review the user has not waived. If the user asks how to auto-allow something,
show them the file's format (README, "Auto-allowed changes") and let them write it.
Deletion is never auto-allowed.

To omit a ticket from a proposal while keeping its working edits, run `jt uncommit ID`;
the proposal's page marks it withdrawn rather than silently dropping it. To discard
working edits, run `jt restore ID`.

## Layers and undo verbs

Ticket state lives in four layers: **working** (`tickets/*.json`, yours to edit),
**committed** (the staged changeset push will send), **base** (last-fetched remote
state), and **seen** (the news baseline behind `jt changes`). Each undo verb targets
exactly one of them — pick by which layer you need to move:

- `jt uncommit ID` — removes the committed copy only; the working file keeps your
  edits. Like `git restore --staged`.
- `jt restore ID` — resets the working file to the committed copy if one is staged,
  otherwise to base; also undoes a staged `jt rm`, `jt archive` or `jt unarchive`.
  Like `git checkout -- <file>`. It
  never touches the committed copy: to abandon a change that is already committed,
  run `jt uncommit` first, then `jt restore`.
- `jt untrack ID` — removes every local layer for the ticket; Jira is untouched.
- `jt resolve KEY` — after a pull conflict only: advances base to the latest remote
  and keeps your whole working file as the desired state. Fields you never edited may
  still hold pre-conflict values, so the next diff can propose reverting the remote's
  newer edits to them — always run `jt diff` after `jt resolve` and fast-forward any
  such field by hand before committing.

## Hard rules

- Edit ticket files only in `tickets/`.
- Do not edit tool-owned `.jira/` files. `.jira/config.json` is the sole exception for
  deliberate workspace configuration changes such as `sync.jql` or `customFields`.
- Never ask for, read, write, or print the API token, credentials file, or
  `$JIRA_API_TOKEN`. Before initialization or remote operations, run `jt config show` to
  verify whether authentication is configured. If authentication is missing, tell the
  user to configure Jira credentials using the authentication mechanism supported by
  their `jt` installation. Do not ask them to paste credentials into chat. Continue only
  after `jt config show` reports a credential source. An API token expires; when one
  has, `jt` stops every remote command with "your Jira API token was rejected". Jira
  itself does not fail cleanly here — it answers a rejected token with 404s and empty
  search results — so treat that error as authoritative and never as evidence that
  tickets were deleted or a project is empty. It is a user action: tell them to mint a
  new token and update the source `jt config show` names. Do not retry in a loop.
- When `jt push` prints a proposal's link, give it to the user and stop. Never open it
  for them, fetch it, or drive it with browser automation, and never approve a proposal
  or try to by any means: the decision on that page is the human's.
- Never report a submitted proposal as pushed, done, or in Jira. It is in Jira only
  when `jt proposals`, `jt await` or `jt log` says it was pushed.
- Do not wait on a review, or hold your turn open for one, unless the user asks you to.
  Run `jt proposals` when you pick work back up; that is how you learn what they decided.
- `jt push` is itself the approval gate: nothing reaches Jira without the human's
  explicit decision on the proposal's page, or a standing one in their own settings
  file. Never ask permission to run it — that gates the gate. Commit, push, and hand the
  user the link (or, for an auto-allowed push, report what was sent).
- Write the title and description for a reviewer who was not here: what the proposal
  does and why. No secrets in either.
- Never create or edit `~/.config/jt/settings.json`. It decides what is sent without
  review, and that decision is the user's alone.
- Name your proposal (`-p NAME`) on every command, commit explicit ids, and never act
  on another proposal's tickets — unless the user asks you to continue that proposal.
- If `jt` prints a notice that a newer version is available, tell the user once, with
  the command it suggests. Do not run the update yourself; `jt` never updates itself.
- Existing comments are append-only. Add a comment without an `id`; never edit or
  remove one with an `id`.
- Existing ticket files retain their `<KEY>.json` name and `key` field.
- To take a ticket off the board, prefer `jt archive KEY` — it is reversible
  (`jt unarchive KEY`) and needs a Jira Premium or Enterprise plan; if the push fails
  because the plan lacks it, say so and ask before falling back. `jt rm KEY` deletes
  permanently and is never the default: propose archiving first, and use `jt rm` only
  when the user asks for deletion in those words. Either way Jira changes only after
  commit and an approved proposal. `jt untrack ID` removes all local state without
  changing Jira. Do not hand-delete tracked files.
- Check `jt status` before committing. If unrelated parked edits exist, commit explicit
  IDs rather than committing everything.

## Ticket files

`jt schema` prints the strict JSON Schema. A typical file is:

```jsonc
{
  "key": "PROJ-123",
  "updated": "2026-07-21T09:14:03.000+0000",
  "project": "PROJ",
  "type": "Story",
  "summary": "…",
  "status": "In Progress",
  "description": "markdown or null",
  "labels": ["api"],
  "parent": "PROJ-100",
  "sprint": "Sprint 42",
  "assignee": "user@example.com",
  "priority": "High",
  "links": [{ "type": "blocks", "to": "PROJ-99" }],
  "comments": [{ "id": "existing-id", "body": "read-only" }, { "body": "new" }],
  "fields": { "Story Points": 5, "Components": ["api"] }
}
```

`key` and `updated` are absent on new tickets. `status` may also be absent, allowing
Jira's default. `parent`, `sprint`, `assignee`, and `priority` may be `null`.

`fields` holds the custom fields named in `customFields`. A missing key and `null` both
mean "no value", and neither is sent. A key can be missing because the ticket was
fetched before the field was configured, or because Jira does not have that field on
the issue at all. Jira only lets a field be set when it is on the issue's edit screen,
and screens often differ by issue type. `jt push` checks this before submitting
anything and names each ticket and field it would refuse. Revert those fields, commit
again, and push. Putting a field on a screen is a Jira configuration change, so leave it to the
user.

Markdown supports headings, paragraphs, lists, fenced code, blockquotes, rules,
emphasis, inline code, strikethrough, and links. Tables, images, and raw HTML are
rejected at commit. If `descriptionLossy` is true, editing `description` replaces
remote content that Markdown could not represent.

Jira stores rich text as ADF, which is stricter than Markdown in three places. Each is
rejected at `jt commit`, naming the field, the line, and the offending text:

- **A code span carries no other formatting.** `` **bold `code`** `` and
  `` *`code`* `` are invalid; write `` **bold** `code` `` instead. A link around a
  code span is the one legal combination: `` [`code`](https://example.com) ``.
- **A blockquote holds only paragraphs, lists and code blocks.** No heading, rule or
  nested quote inside `>`.
- **A list item holds only paragraphs, lists and code blocks.** No heading, rule or
  blockquote indented under a bullet.

These are constraints of Jira's format, not of `jt`. Sent to Jira, each is refused with
`400 INVALID_INPUT` and nothing else — no field, no line, no rule named — which is why
they used to surface as an unexplained failure after the user had already approved the
proposal. `jt commit` now refuses them first and says exactly where. Check the rendered
result in `jt diff` before committing.

## Creating tickets

```sh
jt new my-epic --type Epic --summary "The epic"
jt new my-story --type Story --parent @my-epic
```

Pending creations use `@name` in `parent` and link targets, from other new tickets and
from existing ones alike (for example, re-parenting `PROJ-123` under `@my-epic`). One
push creates the new tickets first, replaces references with Jira keys, and renames the
files.

## Conflicts and aliases

- If push reports staleness, run `jt pull`, review, and recommit if necessary. (Once a
  proposal is submitted, its page does this itself each time the user opens it.)
- If pull reports a conflict, edit the working file to the desired final state, run
  `jt resolve KEY`, review the diff, and commit again.
- If a sprint, field, status, priority, issue type, or link name is unknown, run
  `jt meta sync`.

## Reading

The synced mirror is a local database: `tickets/*.json` hold every ticket `sync.jql`
matches, as ordinary JSON files. For any task that finds, filters, counts, or
summarizes existing tickets, run `jt pull` to freshen the mirror, then read and grep
the ticket files directly — do not fetch tickets one by one or query Jira for data
the workspace already holds.

```sh
jt show KEY                     # working copy
jt show KEY --base              # last fetched copy
jt show KEY --committed         # staged copy
jt diff --committed             # exactly what push will send
jt show --web [KEY...]
jt diff --web
jt changes --web
jt proposals                    # every proposal: state, link, review comments, recent pushes
jt proposals --json             # the same facts as JSON, for a script; read the text form yourself
jt log                          # the last ten pushes
jt log --today                  # everything sent to Jira today
jt log --since 3d PROJ-123      # a window (90m, 12h, 3d, 2w, or a date) and/or tickets
jt log --web --today            # the same history as a page for the user
```

`jt log` is the audit trail of everything `jt` sent to Jira from this workspace: for
each push, whether the user approved it on the proposal's page or it was auto-allowed by
their settings, which proposal it came from, and the field-level change to each ticket.
When the user asks what happened — today, to a ticket, while they were away — answer
from `jt log`, not from memory, and say which pushes went out without a review.

Terminal output is compact by default; `--full` on `jt changes`, `jt log`, and
`jt push --dry-run` prints the long form (description line diffs, every journal op,
raw ADF bodies). Prefer the compact defaults unless the detail is needed.

The `--web` read commands produce a page or path for the user. As with proposal pages,
do not load localhost pages yourself.
