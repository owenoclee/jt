# jt — Jira as a remote VCS

`jt` is a Jira Cloud CLI for agent workflows with human approval. Tickets are local
JSON files, and changes follow a fetch → edit → diff → commit → push cycle.

`jt push` reads only committed snapshots, shows the exact changeset in a local browser
review page, and sends it only after the user approves the whole batch. No other command
mutates Jira.

## Install

Install with Homebrew:

```sh
brew install owenoclee/tap/jt
```

Alternatively, download an archive and its checksum from the
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
sh -c 'umask 077; mkdir -p ~/.config/jira-cli; printf "token: "; IFS= read -rs t; printf "%s" "$t" > ~/.config/jira-cli/credentials; echo'
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

`jt push` prints a local review URL and waits for one decision:

- **Approve & push** sends the whole changeset exactly as shown.
- **Request changes** sends nothing and returns per-ticket notes.

Use `jt push --dry-run` to print the compiled API operations without serving a page or
sending anything.

## Workspaces

`jt init` creates:

```text
tickets/                 working ticket files; edit these
.jira/config.json        workspace configuration; edit sync.jql/customFields here
.jira/base/              remote state from the last fetch
.jira/committed/         snapshots staged for push
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

Pulling never advances the acknowledgment baseline. `jt changes --web` provides the
same report using the user-facing web UI with an Acknowledge button.

## Creating tickets

```sh
jt new big-epic --type Epic --summary "Q3 platform work"
jt new first-story --type Story --summary "First slice" --parent @big-epic
jt diff
jt commit
jt push
```

Pending tickets use `@name` references. After a successful push, `jt` replaces them
with Jira keys and renames their files.

## Scope and safety

`jt` supports ticket creation, updates, deletion, parenting, links, labels, custom
fields, sprint assignment, status transitions, priority, assignee, and append-only
comments. Descriptions and comments use a deterministic Markdown/ADF subset.

It does not manage boards, sprints, plans, goals, users, permissions, or workflows.

- `jt push` refuses if a staged ticket changed remotely after the last fetch.
- `jt rm KEY` stages deletion; Jira is untouched until it is committed and approved.
- Existing comments cannot be edited or removed.
- Unsupported description content is marked with `descriptionLossy`.
- Pushes are journaled with requests, outcomes, and browser approval provenance.

Run `jt schema` for the strict ticket-file JSON Schema. Unknown keys are errors.

## Agents

[SKILL.md](SKILL.md) is the agent contract. Install it in the agent's skills directory
and allow local/read-only `jt` commands as appropriate. `jt push` is the only command
that can mutate Jira and it always requires user confirmation through the browser UI.

The user should create the credential directly; an agent should never ask for, read,
or print the API token.

## Development

```sh
deno task check
deno task test
```
