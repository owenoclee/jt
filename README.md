# jt — Jira as a remote VCS

`jt` is a Jira Cloud CLI for agent workflows with human approval. Tickets are local
JSON files, and changes follow a fetch → edit → diff → commit → push cycle.

`jt push` reads only committed snapshots, shows the exact changeset in a local browser
review page, and sends it only after the user approves the whole batch. No other command
mutates Jira. The one way past the page is a rule the user wrote themselves: kinds of
change they have [auto-allowed](#auto-allowed-changes) are sent without asking.

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
jt await
```

`jt push` prints a local review URL and returns immediately; `jt await` blocks until
the review settles and reports the outcome. The two always go together — a push is
unfinished until `jt await` returns, so `jt push` prints the remaining steps under the
URL. The page offers one decision:

- **Approve & push** sends the whole changeset exactly as shown.
- **Request changes** sends nothing and returns per-ticket notes.

The page never expires — a review takes as long as it takes. `jt cancel` withdraws an
undecided review without sending anything.

Each card lists the ticket's fields in one stable order — changed fields show their
diff with a bold name, unchanged ones (epic, labels, sprint, …) appear as muted
context in place; the ⚙ **fields** control picks which unchanged fields appear
(description is off by default).

Use `jt push --dry-run` to print the compiled API operations without serving a
page or sending anything.

## Parallel agents: proposals

A proposal is a named changeset — its own staged tickets, its own review page, its own
outcome. They are to `jt` what branches are to git, and they exist so that several agents
can work in one workspace at once: without them there is one changeset and one review,
and a second agent's `jt commit` or `jt push` lands in the first agent's.

Name the proposal on any command with `-p NAME` (or `--proposal NAME`, or
`JT_PROPOSAL=NAME` in the environment):

```sh
jt commit -p auth-cleanup ENG-12 ENG-15 -m "tighten session handling"
jt push   -p auth-cleanup        # its own review page
jt await  -p auth-cleanup        # its own outcome

jt commit -p q3-epics @q3-epic @first-story     # meanwhile, another agent
jt push   -p q3-epics && jt await -p q3-epics
```

- Each proposal is reviewed, approved, cancelled and collected on its own. Any number
  can have a review page open at once; the page title names the proposal.
- A ticket is held by **one proposal at a time**. There is a single `tickets/KEY.json`,
  so a second proposal trying to stage it is refused and told who holds it. `jt uncommit
  KEY -p NAME` releases it.
- `jt commit -p NAME` takes explicit ids. With none, it commits only new edits to tickets
  `NAME` already holds — never "everything modified", which in a shared workspace is
  other agents' unfinished work.
- `jt status` shows the whole workspace and tags tickets staged elsewhere with
  `[proposal NAME]`; `jt proposals` lists every proposal with its tickets and review.
- There is deliberately no "current proposal" to switch: that would be shared state, and
  agents switching it under each other is the very clash this removes. The name travels
  with each command.

Commands without a name use the default proposal, which behaves exactly as `jt` always
has. A named proposal's directory disappears once it has been pushed and collected.

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
  review page, nothing to `jt await`.
- When auto-allowed changes are **mixed** with others, nothing is sent early. The whole
  changeset goes to the review page as usual; the auto-allowed changes sit at the bottom
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

Each push is listed with how it was approved — decided on the review page (and how long
the decision took), or sent without review under your auto-allow rules (and which rules)
— the proposal it came from, and the field-level change to every ticket, with
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
.jira/proposals/<name>/  a named proposal's own committed/, intents and review state
.jira/seen/              remote state at the last acknowledgment
.jira/meta.json          Jira names and IDs from jt meta sync
.jira/journal/           every push: requests, results, changes, and how it was approved
```

Files under `.jira/` are tool-owned except `.jira/config.json`.

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
jt await
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

- `jt push` refuses if a staged ticket changed remotely after the last fetch.
- `jt archive KEY` stages archiving and `jt unarchive KEY` reverses it; `jt rm KEY`
  stages permanent deletion. Jira is untouched until committed and approved.
- Existing comments cannot be edited or removed.
- Unsupported description content is marked with `descriptionLossy`.
- Pushes are journaled with requests, outcomes, per-ticket changes, and how each was
  approved: browser provenance for a reviewed push, the matching rules for an
  auto-allowed one. `jt log` reads it back.
- Deletion always goes to the review page; no setting can auto-allow it.

Run `jt schema` for the strict ticket-file JSON Schema. Unknown keys are errors.

## Taking tickets off the board

```sh
jt archive ENG-123      # reversible; Jira Premium/Enterprise only
jt unarchive ENG-123    # brings it back, and back into the mirror
jt rm ENG-123           # permanent deletion
jt commit && jt push && jt await
```

All three are staged intents: nothing reaches Jira until the changeset is approved on
the review page, and `jt restore KEY` abandons one beforehand.

## Markdown and ADF

Descriptions and comments are Markdown, stored in Jira as ADF. `jt commit` rejects
anything ADF cannot represent, quoting the field, line, and text — rather than letting
it fail after the reviewer has already approved the push, where Jira's entire
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
redirect it wherever your agent discovers skills. Allow local/read-only `jt` commands
as appropriate. `jt push` is the only command that can mutate Jira, and it requires user
confirmation through the browser UI for everything except the kinds of change you have
auto-allowed in `~/.config/jt/settings.json`.

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
