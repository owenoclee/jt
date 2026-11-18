# jt — Jira as a remote VCS

`jt` is a Jira Cloud CLI for agent workflows with human approval. Tickets are local
JSON files, and changes follow a fetch → edit → diff → commit → push cycle.

`jt push` submits a **proposal**: the exact changeset, at a link that stays good, for
you to review like a pull request. An agent hands you the link and carries on; you get
to it when you get to it. Approving sends the whole changeset to Jira there and then,
with no agent involved. Nothing else mutates Jira. The one way past the review is a
rule you wrote yourself: kinds of change you have [auto-allowed](#auto-allowed-changes)
are sent without asking.

## Install

On macOS, install with Homebrew:

```sh
brew install owenoclee/tap/jt
```

Release candidates are never installed by that formula. To opt in to them, install the
separate `jt-rc` formula instead (`brew uninstall jt` first — both provide `jt`):

```sh
brew install owenoclee/tap/jt-rc
```

Alternatively, download a macOS or Linux archive and its checksum from the
[latest release](https://github.com/owenoclee/jt/releases/latest), or install from
a checkout with Deno 2.x:

```sh
deno task install
# run without installing:
deno task jt help
```

## Authentication

Create an Atlassian API token at
<https://id.atlassian.com/manage-profile/security/api-tokens>. It must belong to the
account passed to `jt init --email`.

Use an environment variable:

```sh
export JIRA_API_TOKEN=...
```

Or create the durable credentials file without putting the token in shell history:

```sh
sh -c 'umask 077; mkdir -p ~/.config/jt; printf "token: "; IFS= read -rs t; printf "%s" "$t" > ~/.config/jt/credentials; echo'
```

The environment variable takes precedence. `jt config show` reports the active source
without printing the token.

## Quickstart

```sh
mkdir -p ~/jira/ENG && cd ~/jira/ENG
jt init --base-url https://yoursite.atlassian.net --email you@example.com --project ENG
jt meta sync
jt pull

$EDITOR tickets/ENG-123.json
jt diff
jt commit -m "update ENG-123"
jt push
```

`jt push` prints the proposal's link and returns; nothing has been sent. Open the link
(or `jt review` for the list of everything waiting) and decide:

- **Approve & push** sends the whole changeset exactly as shown.
- **Request changes** sends nothing. You leave comments — under a ticket's changes, or
  on the proposal as a whole — and they wait on the proposal for the agent that picks
  it up.

Each card lists the ticket's fields in one stable order — changed fields show their
diff with a bold name, unchanged ones (epic, labels, sprint, …) appear as muted
context in place; the ⚙ **fields** control picks which unchanged fields appear
(description is off by default).

Use `jt push --dry-run` to print the compiled API operations without submitting or
sending anything.

## Reviewing proposals

A proposal is `jt`'s pull request, and its review is asynchronous by design. An agent
finishes its task, submits, gives you a link and ends its turn:

```sh
jt commit -p auth-cleanup ENG-12 ENG-15 -m "tighten session handling"
jt push   -p auth-cleanup --title "Tighten session handling before the audit" \
  --description-file why.md
# proposal submitted for review: http://127.0.0.1:5472/p/ENG/auth-cleanup
```

- **The link is durable.** It is the same across review rounds and agent sessions, and
  across restarts of the server behind it. `http://127.0.0.1:5472/` is the inbox: every
  proposal in every workspace, grouped by whose move it is, plus what you approved in
  the last week.
- **The page shows the proposal against Jira as it is now.** Opening it re-fetches the
  staged tickets. An edit someone made to a field the proposal leaves alone is absorbed
  and noted at the top. An edit to a field it also changes, or a ticket that is gone,
  marks the proposal as needing its agent and disables Approve.
- **What you saw is what ships.** Approval sends only if the operations compiled at
  that moment are exactly the ones the page rendered. If the proposal or Jira moved in
  between, nothing is sent and the page reloads.
- **Comments, as on a pull request.** Asking for changes means commenting, under a
  ticket or on the proposal as a whole. After the agent resubmits, your comments stay
  beside the changes that answer them, tickets it did not touch are collapsed as
  already reviewed, and a *since your last review* tab shows only what changed.
- **Nobody waits.** `jt proposals` is how an agent — the same one later, or another —
  learns what you decided: your comments, or what was pushed. `jt await` exists for the
  times you ask an agent to wait, and `jt cancel` withdraws a proposal from review.
- A proposal changed after it was submitted (another commit, an uncommit) shows as
  *being revised* and cannot be approved until its agent runs `jt push` again.

### The review server

The pages are served by one small local server for all your workspaces, on
`127.0.0.1:5472` only. `jt` starts it when a proposal is submitted, restarts it after
an upgrade, and brings it back after a reboot the next time any `jt` command runs in a
workspace with a proposal waiting. `jt review` prints the inbox URL and starts the
server if needed; `jt serve` runs it in the foreground, `jt serve --stop` stops it, and
`"reviewPort"` in `~/.config/jt/settings.json` moves it.

It reads your API token the same way every `jt` command does. If you keep the token in
`JIRA_API_TOKEN` rather than the credentials file, the server holds the value from the
shell that started it: after rotating the token, `jt serve --stop` and let it restart.

## Parallel agents: one proposal each

A proposal is a named changeset — its own staged tickets, its own link, its own
outcome. They are to `jt` what branches are to git, and they are what lets several
agents work in one workspace at once: without names there is one changeset, and a
second agent's `jt commit` or `jt push` lands in the first agent's.

Name the proposal on any command with `-p NAME` (or `--proposal NAME`, or
`JT_PROPOSAL=NAME` in the environment):

```sh
jt commit -p auth-cleanup ENG-12 ENG-15 -m "tighten session handling"
jt push   -p auth-cleanup --title "Tighten session handling"

jt commit -p q3-epics @q3-epic @first-story     # meanwhile, another agent
jt push   -p q3-epics --title "Q3 platform epics"
```

- Each proposal is reviewed, approved and withdrawn on its own. Any number can be in
  review at once.
- A ticket is held by **one proposal at a time**. There is a single `tickets/KEY.json`,
  so a second proposal trying to stage it is refused and told who holds it. `jt uncommit
  KEY -p NAME` releases it.
- `jt commit -p NAME` takes explicit ids. With none, it commits only new edits to tickets
  `NAME` already holds — never "everything modified", which in a shared workspace is
  other agents' unfinished work.
- `jt status` shows the whole workspace and tags tickets staged elsewhere with
  `[proposal NAME]`; `jt proposals` lists every proposal with its tickets, its review
  state and your comments.
- There is deliberately no "current proposal" to switch: that would be shared state, and
  agents switching it under each other is the very clash this removes. The name travels
  with each command.

Commands without a name use the default proposal — the single-changeset workflow, titled
by its last commit note. A named proposal needs a `--title`, and its directory
disappears once it has been pushed.

## Auto-allowed changes

Some changes are not worth a review — an agent assigning itself a ticket, moving it to
*In Progress*, leaving a comment. You can allow those, by kind, in a settings file:

```jsonc
// ~/.config/jt/settings.json
{
  "autoAllow": [
    "assignee",
    "comment",
    { "action": "status", "to": ["In Progress", "In Review"] },
    { "action": "labels", "project": "SBX" }
  ]
}
```

- When **every** change in a push is auto-allowed, `jt push` sends it immediately: no
  proposal, no review.
- When auto-allowed changes are **mixed** with others, nothing is sent early. The whole
  changeset is submitted for review as usual; the auto-allowed changes sit at the bottom
  — of the card, or of the page when a whole ticket is covered — greyed out and marked
  *auto-allowed based on your configuration*. Approving sends everything; requesting
  changes sends nothing.

A rule is an action name, or an object that narrows it:

| Action | Covers |
| --- | --- |
| `summary` `description` `type` `labels` `parent` `sprint` `assignee` `priority` | an edit to that field of an existing ticket |
| `status` | a workflow transition; `"to": [...]` limits it to transitions *into* those statuses |
| `comment` | a new comment |
| `links` | adding or removing an issue link |
| `fields.<alias>`, `fields.*` | a tracked custom field, or all of them |
| `create` `archive` `unarchive` | the whole operation on a ticket |

`"project": "KEY"` limits any rule to one project. Deletion can never be auto-allowed,
and neither can replacing a description `jt` could only partly read (`descriptionLossy`).
A settings file with a mistake in it stops `jt push` with the reason rather than being
ignored. `jt config show` prints the rules in force.

This file is yours, not the agent's: it lives outside every workspace, next to the
credentials, and the agent contract forbids touching it. Every push it lets through is
recorded as such — see below.

## History

`jt log` is the record of everything `jt` has sent to Jira from a workspace:

```sh
jt log --today               # what happened today?
jt log --since 3d ENG-123    # the last three days, for one ticket
jt log --web --today         # the same, as a page (prints the file path)
jt log --full                # description line diffs and every API call
```

Each push is listed with how it was approved — decided on the proposal's page (and how
long the decision took), or sent without review under your auto-allow rules (and which
rules) — the proposal it came from and its title, and the field-level change to every
ticket, with
auto-allowed changes marked. The underlying journal in `.jira/journal/` also holds each
request and Jira's response.

## Workspaces

`jt init` creates:

```text
tickets/                 working ticket files; edit these
.jira/config.json        workspace configuration; edit sync.jql/customFields here
.jira/base/              remote state from the last fetch
.jira/committed/         snapshots staged for push
.jira/intents.json       staged archiving, un-archiving and deletion
.jira/proposals/<name>/  a named proposal's own committed/, intents and proposal.json
.jira/proposal.json      the default proposal's title, review state and comments
.jira/seen/              remote state at the last acknowledgment
.jira/meta.json          Jira names and IDs from jt meta sync
.jira/journal/           every push: requests, results, changes, and how it was approved
```

Files under `.jira/` are tool-owned except `.jira/config.json`. Commands that change
them take a lock on the workspace, so agents working at once — and a push you approve
while they do — never interleave.

Workspaces mirror their project by default. `jt init` sets `sync.jql` to
`project = KEY`; `jt pull` then adds, updates, and removes clean local copies to match
that JQL. Edit `sync.jql` to narrow the mirror, or remove `sync` to track individual
tickets with `jt fetch`.

Remote edits to untouched fields rebase automatically. Overlapping local and remote
edits become conflicts resolved with `jt resolve`.

## Upstream changes

`jt pull` updates the local mirror. `jt changes` reports what changed remotely since
the last acknowledgment:

```sh
jt pull
jt changes
jt changes --ack
```

Pulling never advances the acknowledgment baseline. An approved push does, for exactly
the approved delta — your own pushes do not come back as news. `jt changes --web`
provides the same report using the user-facing web UI with an Acknowledge button.

## Creating tickets

```sh
jt new big-epic --type Epic --summary "Q3 platform work"
jt new first-story --type Story --summary "First slice" --parent @big-epic
jt diff
jt commit
jt push
```

Pending tickets use `@name` references — existing tickets may use them too (for
example, re-parenting a tracked ticket under `@big-epic`). After a successful push,
`jt` replaces them with Jira keys and renames their files.

## Scope and safety

`jt` supports ticket creation, updates, deletion, parenting, links, labels, custom
fields, sprint assignment, status transitions, priority, assignee, archiving, and
append-only comments. Descriptions and comments use a deterministic Markdown/ADF
subset.

It does not manage boards, sprints, plans, goals, users, permissions, or workflows.

- `jt push` refuses if a staged ticket changed remotely after the last fetch; once
  submitted, the proposal is rebased onto Jira each time its page is opened, and
  approval re-checks.
- `jt push` also refuses, before sending anything, a custom field that is not on the
  issue's edit screen in Jira, since Jira would reject it partway through the push.
  A missing custom-field key and `null` both mean no value, and neither one is sent.
- A push stops at the first operation Jira refuses. Whatever did not land stays
  staged, and `jt status` and `jt proposals` mark it as left over from that push.
- `jt archive KEY` stages archiving and `jt unarchive KEY` reverses it; `jt rm KEY`
  stages permanent deletion. Jira is untouched until committed and approved.
- Existing comments cannot be edited or removed.
- Unsupported description content is marked with `descriptionLossy`.
- Pushes are journaled with requests, outcomes, per-ticket changes, and how each was
  approved: browser provenance for a reviewed push, the matching rules for an
  auto-allowed one. `jt log` reads it back.
- Deletion always goes to review; no setting can auto-allow it.
- The review server listens on loopback only. A decision is accepted only from a page
  it rendered itself (same origin, with a token bound to exactly what that page showed),
  pages cannot be framed, and markdown that came from Jira is rendered with raw HTML
  escaped and nothing loaded from elsewhere.

Run `jt schema` for the strict ticket-file JSON Schema. Unknown keys are errors.

## Taking tickets off the board

```sh
jt archive ENG-123      # reversible; Jira Premium/Enterprise only
jt unarchive ENG-123    # brings it back, and back into the mirror
jt rm ENG-123           # permanent deletion
jt commit && jt push
```

All three are staged intents: nothing reaches Jira until the proposal is approved, and
`jt restore KEY` abandons one beforehand.

## Markdown and ADF

Descriptions and comments are Markdown, stored in Jira as ADF. `jt commit` rejects
anything ADF cannot represent, quoting the field, line, and text — rather than letting
it fail after the reviewer has already approved the proposal, where Jira's entire
explanation is `400 {"errorMessages":["INVALID_INPUT"]}`. Beyond the unsupported
constructs (tables, images, raw HTML), three ADF rules catch people out:

- a code span cannot also be bold, italic or struck through — `` **bold** `code` ``,
  not `` **bold `code`** `` (a link around a code span is fine)
- a blockquote holds only paragraphs, lists and code blocks
- a list item holds only paragraphs, lists and code blocks

## Expired API tokens

Atlassian API tokens expire, and Jira does not answer a rejected token with a clean
error. Against a live site, a bad token gets `401` on `/myself`, `404 "issue does not
exist or you do not have permission"` on a single issue — in Chinese unless the request
asks for English, whatever language the site itself is set to — and, worst of all, `200`
with an empty issue list on a search, as if the project had been emptied. Read by status
alone, an expired token is indistinguishable from every ticket having been deleted.

Jira does mark these: every such response carries `x-seraph-loginreason:
AUTHENTICATED_FAILED`, and a valid token never does. `jt` checks that header on every
response, whatever its status, and stops with an expired-token error naming the
credential source in use — rather than pulling an empty result set over your mirror.

## Agents

[SKILL.md](SKILL.md) is the agent contract. Install it with `jt skill install
claude-code` or `jt skill install codex`, or print it with `jt skill show` and
redirect it wherever your agent discovers skills. After an upgrade, jt refreshes an
installed skill to match itself on its next run; a copy you have edited is left alone,
with a warning. Allow local/read-only `jt` commands as appropriate. No `jt` command an
agent runs mutates Jira except `jt push` of a changeset made only of the kinds of change
you have auto-allowed in `~/.config/jt/settings.json`; everything else waits for your
approval in the browser.

The user should create the credential directly; an agent should never ask for, read,
or print the API token — and should never create or edit the settings file.

## Updates

`jt` asks GitHub at most once a day whether a newer release exists and, when one does,
prints a short notice on stderr with the command to update — at most once a day. It never
downloads or installs anything. A stable build is only told about stable releases; a
release-candidate build is told about newer candidates too.

Turn the check off with `JT_NO_UPDATE_CHECK=1`, or `"updateCheck": false` in
`~/.config/jt/settings.json`. It is also skipped when `CI` is set.

## Development

```sh
deno task check
deno task test
```
