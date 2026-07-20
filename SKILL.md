# jt — Jira tickets as local files (agent contract)

`jt` treats Jira like a remote VCS. Tickets are JSON files in `tickets/`. You edit
desired state; the tool computes diffs, the user reviews them, and `jt push` compiles
the approved state into API calls. You never author API payloads and never re-type
JSON into a tool call — the file on disk is the single unit of intent.

## The workflow contract

```
jt fetch PROJ-123          # or: jt fetch --jql 'project = PROJ AND sprint in openSprints()'
# edit tickets/PROJ-123.json (the ONLY files you may edit are in tickets/)
jt diff                    # inspect what changed
jt commit -m "round 1: …"  # stage the proposal (local, safe); -m narrates the round
jt push --await-user       # THE ONLY REMOTE-MUTATING COMMAND — opens a browser review
                           # page; the user approves/rejects per ticket; only approved
                           # tickets are sent
```

**Prefer `jt push --await-user` whenever a human is in the loop.** It renders the
changeset as a PR-style page (full diff, per-round commit deltas, "since your last
review", tickets unchanged since the last review auto-collapsed), served by the same
process that executes the push. The gate is **atomic**: the user either approves the
WHOLE changeset (everything ships, exactly as rendered) or requests changes (NOTHING
ships; their per-ticket notes come back on stdout). Exit codes: `0` approved & pushed ·
`2` changes requested (read the notes, act, push again) · `1` timeout/stale/failure.
Run it in the background if your tool-call timeout is shorter than the review timeout
(default 600s; `--timeout`).

Acting on notes: if a note asks for edits, edit the working file, `jt commit -m` a new
round, push again. If a note says to ship without a particular ticket, run
`jt uncommit <ID>` (keeps the working edits, removes it from the changeset — the
`git restore --staged` analog) and push again; the next page shows the smaller
changeset. `jt restore <ID>` is the `git checkout --` analog: discards working edits
(resets to committed if staged, else base) and also undoes `jt rm`.

**Opening the page is YOUR job (the agent's).** jt prints `review page: <url>` and
waits — it does not launch a browser (sandboxed shells can't). Extract that URL from
the output and hand it to the OS opener for the user, e.g. `open "<url>"` on macOS
(this may need to run outside the sandbox). Launching the user's browser at the URL
is expected and required; what is forbidden is YOU loading it — never fetch(), curl,
or drive browser-automation tools at the review URL. jt itself accepts `--open` for
humans running it directly in a normal terminal.

`jt commit -m` messages become the round history on the page — write them for the
reviewer. Plain `jt push` (no browser gate) still exists for non-interactive use.

**Push is tamper-proof by construction**: it compiles from the tool-owned committed
layer, never from working files. Editing a working file after `jt commit` does not
change what push sends — it just shows up as a new uncommitted change afterwards.

## Hard rules

- **Never** edit anything under `.jira/` (base/committed layers, meta, chain, journal — tool-owned).
- Only `jt push` mutates Jira. Everything else is local or read-only, safe to allowlist.
- **Never open, read, or interact with the review page URL** (`http://127.0.0.1:…`)
  with browser tools. The page exists so the HUMAN can approve out-of-band; an agent
  clicking it defeats the entire mechanism. Localhost must not be in any browser-tool
  allowlist. Wait for the command to exit and read its stdout instead.
- Comments are **append-only**: add entries WITHOUT an `id`; never edit or remove
  entries that have an `id`.
- Existing-ticket files are named `<KEY>.json` and must keep their `key` field.
- Don't hand-delete a working file: use `jt rm KEY` (stage remote deletion) or
  `jt untrack KEY` (drop locally, Jira untouched).

## Ticket file format

`jt schema` prints the JSON Schema. Unknown keys are hard errors (typo protection).

```jsonc
{
  "key": "PROJ-123",                    // absent on new tickets
  "project": "PROJ",
  "type": "Story",                      // "Epic" for epics — resolved via meta
  "summary": "…",
  "status": "In Progress",              // editing this = workflow transition on push
  "description": "markdown or null",
  "labels": ["a", "b"],
  "parent": "PROJ-100",                 // epic/parent key, "@name" for a pending creation, or null
  "sprint": "Sprint 42",                // sprint name or id; null = backlog
  "assignee": "user@example.com",       // email, "accountId:<id>", or null
  "priority": "High",
  "links": [{ "type": "blocks", "to": "PROJ-99" }],   // phrases from `jt meta show`
  "comments": [ { "id": "…", "body": "existing — read-only" },
                { "body": "new comment to post" } ],
  "fields": { "Story Points": 5 }       // tracked custom fields by display name
}
```

- Markdown subset: headings, paragraphs, bullet/ordered lists, fenced code blocks,
  blockquotes, rules, bold/italic/inline-code/strikethrough/links. Tables, images,
  and raw HTML are rejected at commit time.
- `"descriptionLossy": true` (set by fetch) means the remote description has content
  the subset can't represent — editing the description then replaces all of it.

## Creating tickets

```
jt new my-epic --type Epic --summary "The epic"
jt new my-story --type Story
```
Edit the files; reference the epic from the story as `"parent": "@my-epic"`, and link
with `"links": [{"type": "blocks", "to": "@my-epic"}]` if needed. One push creates
parents before children, then renames the files to their real keys.

## When things diverge

- `jt push` refuses if the remote changed since your fetch → run `jt pull`.
- `jt pull` merges remote changes into your files; overlapping edits become a
  **conflict**: edit the working file to the desired final state, then `jt resolve KEY`
  and re-commit.
- `jt status` flags every abnormal state with the command to run.
- Unknown sprint/field/status/link names → `jt meta sync` refreshes the alias maps.

## Reading

- `jt show PROJ-123` renders the working copy; `--base` shows remote-as-fetched;
  `--committed` shows what's staged for push.
- `jt show --web [KEY...]` writes a read-only workspace-browser page (fully rendered
  ticket cards; no args = all tracked tickets) and prints its path — open it for the
  user (or pass `--open`). Use it to show the user what a fetch brought down.
- `jt diff --web` writes the current diff as a read-only browser page (same renderer
  as the review page) and prints its file path — open that path for the user (or pass
  `--open`). Useful mid-refinement before anything is committed.
- `jt log` renders the push journal — every API call ever sent, with responses.

## Suggested permission setup

Allowlist: `jt fetch`, `jt pull`, `jt status`, `jt diff`, `jt show`, `jt commit`,
`jt new`, `jt meta`, `jt log`, `jt schema`, `jt config show`.
Always prompt: `jt push`, `jt rm`, `jt untrack`, `jt resolve`, `jt init`.
