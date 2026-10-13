/**
 * User settings: ~/.config/jt/settings.json.
 *
 * Unlike .jira/config.json — workspace configuration an agent may edit — this file is
 * the USER's. It holds the decisions that widen what jt does without asking: which
 * kinds of change push may send with no review (autoAllow). An agent granting itself
 * that would defeat the approval gate, so the file lives outside every workspace, next
 * to the credentials, and the agent contract (SKILL.md) puts it off limits.
 *
 * Absent file = no auto-allow rules: every push goes to the review page, as before.
 * A malformed file is an error, never a silent fallback in either direction.
 */
import { join } from "@std/path";
import { z } from "zod";
import { configHome } from "./config.ts";
import { fail } from "./errors.ts";

/** One kind of change the user has agreed to send without reviewing it. */
export interface AutoAllowRule {
  /** A ticket field, "comment", "fields.<alias>" / "fields.*", or "create" / "archive" / "unarchive". */
  action: string;
  /** Restrict the rule to one Jira project key. */
  project?: string;
  /** status only: restrict the rule to transitions INTO these statuses. */
  to?: string[];
}

export interface Settings {
  autoAllow: AutoAllowRule[];
  /** False disables the once-a-day check for a newer jt release. */
  updateCheck: boolean;
}

export const settingsPath = (): string => join(configHome(), "jt", "settings.json");

const FIELD_ACTIONS = [
  "summary",
  "description",
  "type",
  "status",
  "labels",
  "parent",
  "sprint",
  "assignee",
  "priority",
  "links",
  "comment",
];
const WHOLE_TICKET_ACTIONS = ["create", "archive", "unarchive"];
const ALIASES: Record<string, string> = {
  comments: "comment",
  transition: "status",
  link: "links",
  label: "labels",
};

/** Every action name a rule may use, for error messages and docs. */
export const AUTO_ALLOW_ACTIONS = [...FIELD_ACTIONS, "fields.<alias>", ...WHOLE_TICKET_ACTIONS];

function normalizeAction(raw: string): string {
  const action = ALIASES[raw.trim().toLowerCase()] ?? raw.trim();
  const lower = action.toLowerCase();
  if (lower === "delete") {
    throw new Error("'delete' can never be auto-allowed — deletion is permanent");
  }
  if (FIELD_ACTIONS.includes(lower) || WHOLE_TICKET_ACTIONS.includes(lower)) return lower;
  // Custom-field aliases are display names and keep their case: "fields.Story Points".
  if (/^fields\..+/i.test(action)) return `fields.${action.slice("fields.".length)}`;
  throw new Error(`unknown action '${raw}' — one of: ${AUTO_ALLOW_ACTIONS.join(", ")}`);
}

const RuleSchema = z.union([
  z.string().min(1),
  z.strictObject({
    action: z.string().min(1),
    project: z.string().min(1).optional(),
    to: z.array(z.string().min(1)).min(1).optional(),
  }),
]);

const SettingsSchema = z.strictObject({
  autoAllow: z.array(RuleSchema).optional(),
  updateCheck: z.boolean().optional(),
});

export function parseSettings(data: unknown, source: string): Settings {
  const result = SettingsSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    fail(`invalid settings ${source}:\n${issues.join("\n")}`);
  }
  const autoAllow: AutoAllowRule[] = [];
  for (const [i, raw] of (result.data.autoAllow ?? []).entries()) {
    const rule = typeof raw === "string" ? { action: raw } : raw;
    try {
      const action = normalizeAction(rule.action);
      if (rule.to && action !== "status") {
        throw new Error(`'to' only applies to the status action, not '${action}'`);
      }
      autoAllow.push({
        action,
        ...(rule.project ? { project: rule.project.toUpperCase() } : {}),
        ...(rule.to ? { to: rule.to } : {}),
      });
    } catch (e) {
      fail(`invalid settings ${source}:\n  - autoAllow.${i}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { autoAllow, updateCheck: result.data.updateCheck ?? true };
}

export function loadSettings(): Settings {
  const path = settingsPath();
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return { autoAllow: [], updateCheck: true };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    fail(`invalid settings ${path}: not valid JSON — ${e instanceof Error ? e.message : e}`);
  }
  return parseSettings(data, path);
}

/** "status → In Progress, Done (ENG)" — a rule as shown in output and the journal. */
export function describeRule(rule: AutoAllowRule): string {
  const to = rule.to ? ` → ${rule.to.join(", ")}` : "";
  const project = rule.project ? ` (${rule.project})` : "";
  return `${rule.action}${to}${project}`;
}
