/**
 * Proposals: named, independent changesets — jt's answer to git branches.
 *
 * Every staged change belongs to exactly one proposal, and each proposal has its own
 * committed layer, commit chain, and review (page, decision, outcome). Agents working
 * in parallel in one workspace each name their own (`-p NAME` on any command, or
 * `JT_PROPOSAL`), so one agent's commit, push, await or cancel never touches another's.
 *
 * There is deliberately no "current proposal" stored in the workspace: that would be
 * shared state, and two agents switching it under each other is exactly the clash
 * proposals exist to remove. The name travels with each command instead. A command that
 * names none works on the default proposal — the single-agent workflow, unchanged.
 */
import { fail } from "./errors.ts";

export const DEFAULT_PROPOSAL = "default";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

let active: string | null = null;

export function validateProposalName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    fail(
      `invalid proposal name '${name}' — use lowercase letters, digits, dashes and ` +
        `underscores (at most 48 characters), for example: -p auth-cleanup`,
    );
  }
  return name;
}

/** Set by main() from -p/--proposal; tests call it directly. */
export function setActiveProposal(name: string | null): void {
  active = name === null ? null : validateProposalName(name);
}

/** The proposal this invocation works on: -p/--proposal, else $JT_PROPOSAL, else default. */
export function activeProposal(): string {
  if (active !== null) return active;
  const env = Deno.env.get("JT_PROPOSAL")?.trim();
  return env ? validateProposalName(env) : DEFAULT_PROPOSAL;
}

/**
 * Pull the global -p/--proposal flag out of an argv, wherever it sits, leaving the
 * rest for the command's own parser. Stops at a bare `--`.
 */
export function extractProposalFlag(argv: string[]): { proposal: string | null; rest: string[] } {
  const rest: string[] = [];
  let proposal: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === "-p" || arg === "--proposal") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) fail(`${arg} needs a proposal name`);
      proposal = value;
    } else if (arg.startsWith("--proposal=")) {
      proposal = arg.slice("--proposal=".length);
    } else {
      rest.push(arg);
    }
  }
  return { proposal, rest };
}

/** " -p NAME" for a named proposal, "" for the default — for commands jt prints as hints. */
export function proposalFlag(name: string): string {
  return name === DEFAULT_PROPOSAL ? "" : ` -p ${name}`;
}

/** " -p NAME" always — for hints that send the reader to ANOTHER proposal, default included. */
export function explicitProposalFlag(name: string): string {
  return ` -p ${name}`;
}
