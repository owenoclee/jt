# jt — Jira as a remote VCS

`jt` is a Jira Cloud CLI for agent workflows with human approval. Tickets are local
JSON files, and changes follow a fetch → edit → diff → commit → push cycle.

`jt push` reads only committed snapshots, shows the exact changeset in a local browser
review page, and sends it only after the user approves the whole batch. No other command
mutates Jira.

## Install

On macOS, install with Homebrew:

```sh
brew install owenoclee/tap/jt
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

## Workspaces

`jt init` creates:

```text
tickets/                 working ticket files; edit these
.jira/config.json        workspace configuration; edit sync.jql/customFields here
.jira/base/              remote state from the last fetch
.jira/committed/         snapshots staged for push
.jira/intents.json       staged archiving, un-archiving and deletion
.jira/seen/              remote state at the last acknowledgment
.jira/meta.json          Jira names and IDs from jt meta sync
.jira/journal/           push requests, results, and approval provenance
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
- Pushes are journaled with requests, outcomes, and browser approval provenance.

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
as appropriate. `jt push` is the only command
that can mutate Jira and it always requires user confirmation through the browser UI.

The user should create the credential directly; an agent should never ask for, read,
or print the API token.

## Development

```sh
deno task check
deno task test
```
