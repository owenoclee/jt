# jt — Jira as a remote VCS

A Jira Cloud CLI built for **agentic workflows with a human in the loop**. Tickets are
local JSON files; changes flow through a git-like fetch → edit → diff → commit → push
cycle, and the push compiles *exactly* the reviewed-and-committed state into API calls.

## Why

Agent tooling around Jira (MCP + a skill) can't ground user approval: the JSON the
user reviews in chat and the request the agent sends are two different objects, because
the agent re-types payloads into tool calls. Transcription is where typos and silent
liberties live.

`jt` closes that gap structurally:

- **Files are the unit of intent.** The agent edits a file that *is* the ticket. It
  never authors an API payload.
- **Diffs are computed, not composed.** `jt diff` derives what changed from files on
  disk with audited code — the user reviews that, like a code review.
- **Push reads only tool-owned layers.** `jt commit` byte-copies the approved working
  file into `.jira/committed/`; `jt push` compiles committed−base into API operations.
  Tampering with a working file after review provably cannot change what is sent.
- **One mutating verb.** Everything except `jt push` is local or read-only, so a
  permission system (e.g. Claude Code's) can allowlist the whole workflow and gate
  exactly the one command that touches Jira — with the full op list printed in its
  output.
- **A browser review gate.** `jt push --await-user` serves the changeset as a
  PR-style page on localhost — full diff vs Jira, per-round commit deltas ("what did
  the agent change since I last looked"), per-ticket approve/reject with notes — and
  the same process that rendered the page executes exactly the approved subset.
  Rejection notes flow back to the agent through stdout; approved tickets leave the
  changeset, so each review round only shows what's still in question.

## Install

Requires [Deno](https://deno.com) 2.x.

```sh
deno task install        # installs the `jt` command globally
# or run from the repo without installing:
deno task jt help
```

## Quickstart

```sh
mkdir my-jira-workspace && cd my-jira-workspace
export JIRA_API_TOKEN=...           # or ~/.config/jira-cli/credentials (0600)
jt init --base-url https://yoursite.atlassian.net --email you@example.com --project ENG
jt meta sync                        # alias maps: fields, issue types, sprints, statuses...

jt fetch ENG-123                    # materializes tickets/ENG-123.json
$EDITOR tickets/ENG-123.json        # edit desired state (or let your agent do it)
jt diff                             # review the change (or: jt diff --web)
jt commit -m "first round"          # stage it
jt push --await-user                # approve per ticket in the browser, then it sends
# or: jt push                       # non-interactive; prints every API op first
```

Create an epic with a child story in one push:

```sh
jt new big-epic --type Epic --summary "Q3 platform work"
jt new first-story --type Story --summary "First slice" --parent @big-epic
jt diff && jt commit && jt push     # parents created first; files renamed to real keys
```

## The model

```
tickets/ENG-123.json        working tree — the only files you (or your agent) edit
.jira/base/ENG-123.json     remote state as of last fetch          (tool-owned)
.jira/committed/…           approved snapshots, byte copies        (tool-owned)
.jira/meta.json             alias maps from `jt meta sync`         (tool-owned)
.jira/journal/…             every push: exact requests + responses (tool-owned)
```

Three layers, git-style: `status`/`diff` compare them, `commit` promotes working →
committed, `push` compiles committed − base, executes, and advances base by refetching.
`pull` rebases: remote changes to fields you didn't touch flow in silently; overlapping
edits become explicit conflicts (`jt resolve`).

## What it covers

Tickets only, by design: create / read / update / delete, epics and parenting, issue
links ("blocks", "relates to", any link type in your instance), labels, custom fields
(by display name), sprint assignment, status transitions (declarative: edit `status`,
jt finds the transition), and append-only comments — all in markdown, converted
deterministically to/from ADF.

Out of scope: sprint/board management, Plans, goals, users, permissions, workflows.

## Ticket file

See [SKILL.md](SKILL.md) for the agent-facing contract and the full format; `jt schema`
prints the JSON Schema (strict — unknown keys are errors, so typos fail loudly).

## Safety properties

- `jt push` refuses when the remote moved since your fetch (per-ticket staleness guard).
- `jt rm` records the target's summary and stages deletion for review; nothing is
  deleted until a committed deletion is pushed.
- Descriptions containing ADF beyond the markdown subset are flagged lossy; untouched
  descriptions are never rewritten (diffs compare canonical markdown, so round-tripping
  can't produce phantom changes).
- Every push is journaled with the exact request bodies sent and responses received.

## Development

```sh
deno task test     # unit + e2e against an in-process mock Jira
deno task check    # typecheck + lint
```
