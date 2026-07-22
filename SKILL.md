---
name: jt
description: Manage Jira tickets with the jt CLI using local ticket files, computed diffs, and a human-approved push. Use for reading, creating, editing, linking, labeling, transitioning, commenting on, or deleting Jira tickets, assigning sprint work, or reviewing board changes.
---

# jt agent contract

`jt` treats Jira like a remote VCS. Edit ticket files, inspect computed diffs, commit
the intended state, and let the user approve the whole push in a browser.

## Workspace discovery and setup

A directory is a `jt` workspace if it contains:

```text
.jira/config.json
```

Starting at the current directory, check that directory and each ancestor for
`.jira/config.json`. This is also how `jt` locates a workspace automatically. If found,
use the nearest workspace.

If no ancestor workspace exists, search the conventional durable location `~/jira/` for
directories containing `.jira/config.json`. If a suitable workspace is found there, use
it after confirming the project.

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
diffs. Changes the user approved on a push review page are recorded as seen
automatically and do not reappear here.

Use `jt fetch KEY...` when tracking individual tickets rather than a mirror.

## Change workflow

```sh
jt fetch PROJ-123
# edit tickets/PROJ-123.json
jt diff PROJ-123
jt commit PROJ-123 -m "explain the change"
jt push
```

`jt push` is the only command that mutates Jira. It:

1. Compiles committed state, never the working files.
2. Checks that Jira has not changed since the last fetch.
3. Serves a local review page.
4. Sends the entire changeset only when the user selects **Approve & push**.

**Request changes** sends nothing and returns notes on stdout. Exit status is `0` for
approved and pushed, `2` for changes requested, and `1` for timeout, staleness, or
failure. The default review timeout is 600 seconds; override it with `--timeout SECS`.

`jt push --dry-run` prints the compiled operations without serving or sending.

When `jt push` prints `review page: <url>`, open that URL for the user with the OS
opener if available. Never fetch it, inspect it, or interact with it using browser
automation: approval belongs to the human.

If the user requests edits, update the working file and commit another round. To omit
a ticket while keeping its working edits, run `jt uncommit ID`; the next review page
marks it withdrawn rather than silently dropping it. To discard working edits, run
`jt restore ID`.

## Hard rules

- Edit ticket files only in `tickets/`.
- Do not edit tool-owned `.jira/` files. `.jira/config.json` is the sole exception for
  deliberate workspace configuration changes such as `sync.jql` or `customFields`.
- Never ask for, read, write, or print the API token, credentials file, or
  `$JIRA_API_TOKEN`. Before initialization or remote operations, run `jt config show` to
  verify whether authentication is configured. If authentication is missing, tell the
  user to configure Jira credentials using the authentication mechanism supported by
  their `jt` installation. Do not ask them to paste credentials into chat. Continue only
  after `jt config show` reports a credential source.
- Never interact with a review-page URL yourself.
- Existing comments are append-only. Add a comment without an `id`; never edit or
  remove one with an `id`.
- Existing ticket files retain their `<KEY>.json` name and `key` field.
- Use `jt rm KEY` for remote deletion; Jira changes only after commit and push. Use
  `jt untrack ID` to remove all local state without changing Jira. Do not hand-delete
  tracked files.
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

Markdown supports headings, paragraphs, lists, fenced code, blockquotes, rules,
emphasis, inline code, strikethrough, and links. Tables, images, and raw HTML are
rejected at commit. If `descriptionLossy` is true, editing `description` replaces
remote content that Markdown could not represent.

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

- If push reports staleness, run `jt pull`, review, and recommit if necessary.
- If pull reports a conflict, edit the working file to the desired final state, run
  `jt resolve KEY`, review the diff, and commit again.
- If a sprint, field, status, priority, issue type, or link name is unknown, run
  `jt meta sync`.

## Reading

```sh
jt show KEY                     # working copy
jt show KEY --base              # last fetched copy
jt show KEY --committed         # staged copy
jt diff --committed             # exactly what push will send
jt show --web [KEY...]
jt diff --web
jt changes --web
jt log
```

Terminal output is compact by default; `--full` on `jt changes`, `jt log`, and
`jt push --dry-run` prints the long form (description line diffs, every journal op,
raw ADF bodies). Prefer the compact defaults unless the detail is needed.

The `--web` read commands produce a page or path for the user. As with review pages,
do not load localhost pages yourself.
