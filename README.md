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
  the agent change since I last looked"), tickets unchanged since your last review
  auto-collapsed — and the same process that rendered the page executes the push. The
  gate is atomic, like a PR merge: **Approve & push** sends the whole changeset
  exactly as rendered; **Request changes** sends nothing and returns your per-ticket
  notes to the agent. Reshaping the batch happens in the layers (`jt uncommit`, the
  `git restore --staged` analog), never inside the send button.

## Install

Grab a prebuilt binary from the
[latest release](https://github.com/owenoclee/jira-cli/releases/latest)
(Linux and macOS, x64 + arm64, plus Windows x64) — no runtime required:

```sh
chmod +x jt-aarch64-apple-darwin           # whichever matches your platform
mv jt-aarch64-apple-darwin /usr/local/bin/jt
```

Or from a checkout, with [Deno](https://deno.com) 2.x:

```sh
deno task install        # installs the `jt` command globally
# or run from the repo without installing:
deno task jt help
```

## Authentication

`jt` talks to Jira Cloud with Basic auth: your Atlassian account email plus an API
token. Create the token at
<https://id.atlassian.com/manage-profile/security/api-tokens> ("Create API token") —
it must belong to the same account whose email you pass to `jt init --email`.

Give it to `jt` either way (the env var wins if both are set):

```sh
export JIRA_API_TOKEN=...     # shell env — good for one-offs and CI
```

or write it to the credentials file — durable, `0600`, read by nothing but `jt`.
This one-liner prompts for the token so it never lands in your shell history:

```sh
sh -c 'umask 077; mkdir -p ~/.config/jira-cli; printf "token: "; IFS= read -rs t; printf "%s" "$t" > ~/.config/jira-cli/credentials; echo'
```

Once inside a workspace, `jt config show` reports which source is active — it names
the source, never the value.

## Quickstart

```sh
mkdir -p ~/jira/ENG && cd ~/jira/ENG      # one durable workspace per project
jt init --base-url https://yoursite.atlassian.net --email you@example.com --project ENG
jt meta sync                        # alias maps: fields, issue types, sprints, statuses...
jt pull                             # clones the project: every ticket → tickets/ENG-*.json

$EDITOR tickets/ENG-123.json        # edit desired state (or let your agent do it)
jt diff                             # review the change (or: jt diff --web)
jt commit -m "first round"          # stage it
jt push --await-user                # approve per ticket in the browser, then it sends
# or: jt push                       # non-interactive; prints every API op first
```

The workspace is a **mirror** by default: `jt init` writes `sync.jql` (`project = ENG`)
into the config, and every `jt pull` reconciles the whole slice — new remote tickets
appear, edits rebase in, deletions leave. Pulls are incremental (one newest-first search
bounded by an `updated` watermark, plus a keys-only sweep for deletions), so a morning
pull over a 500-ticket backlog costs a handful of API calls, not 500. Narrow `sync.jql`
to any JQL you like, or delete it to track tickets one by one with `jt fetch`.

### What changed since I last looked?

`jt pull` answers "make local current"; `jt changes` answers "what's new to *me*":

```sh
jt pull                             # sync the mirror
jt changes                          # new / changed / gone since your last ack, full diffs
jt changes --ack                    # absorb: current remote state becomes your baseline
```

The baseline (`.jira/seen/`) advances only on `--ack` — pulls can run on cron all day
without eating anyone's morning review. It's read-only bookkeeping: it never feeds
`jt push`, so it can't change what gets sent.

Create an epic with a child story in one push:

```sh
jt new big-epic --type Epic --summary "Q3 platform work"
jt new first-story --type Story --summary "First slice" --parent @big-epic
jt diff && jt commit && jt push     # parents created first; files renamed to real keys
```

## Setting up an agent

`jt` is built to be driven by a coding agent with a human approving pushes. Three
steps — and note who does which:

1. **Install the skill.** [SKILL.md](SKILL.md) is the agent contract and ships with
   frontmatter, so it drops straight into a skills folder — for Claude Code:

   ```sh
   mkdir -p ~/.claude/skills/jt
   curl -fsSL https://raw.githubusercontent.com/owenoclee/jira-cli/main/SKILL.md \
     -o ~/.claude/skills/jt/SKILL.md
   ```

2. **You create the credential — not the agent.** Run the one-liner from
   [Authentication](#authentication) in your own terminal, so the token never
   appears in a chat transcript (SKILL.md forbids the agent from handling it).
   After `jt init`, the agent verifies with `jt config show`, which names the
   token's source without printing it.

3. **Set permissions.** Allowlist the local/read-only commands and gate the one
   mutating verb (`jt push`) — the suggested split is at the bottom of SKILL.md.

## The model

```
tickets/ENG-123.json        working tree — the only files you (or your agent) edit
.jira/base/ENG-123.json     remote state as of last fetch          (tool-owned)
.jira/committed/…           approved snapshots, byte copies        (tool-owned)
.jira/seen/ENG-123.json     remote state as of your last ack       (tool-owned)
.jira/sync.json             mirror watermark + scope membership    (tool-owned)
.jira/meta.json             alias maps from `jt meta sync`         (tool-owned)
.jira/journal/…             every push: exact requests + responses (tool-owned)
```

Three layers, git-style: `status`/`diff` compare them, `commit` promotes working →
committed, `push` compiles committed − base, executes, and advances base by refetching.
`pull` rebases: remote changes to fields you didn't touch flow in silently; overlapping
edits become explicit conflicts (`jt resolve`). The seen layer is a fourth, *anchored*
copy — it advances only when you acknowledge (`jt changes --ack`), so `jt changes` can
always answer "what has the remote done since my last knowledge of the board."

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
