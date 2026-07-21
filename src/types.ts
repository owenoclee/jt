/**
 * Core data model. A Ticket is the canonical file form the agent edits: human-readable
 * aliases everywhere, markdown for rich text. The same shape is stored in all three
 * layers (working / committed / base) so layers can be byte- and field-compared.
 */

export interface LinkEntry {
  /** Link direction phrase as Jira displays it, e.g. "blocks", "is blocked by", "relates to". */
  type: string;
  /** Issue key, or "@<file-stem>" referencing a sibling pending-creation file. */
  to: string;
}

export interface CommentEntry {
  /** Present on comments fetched from Jira (read-only). Absent = new comment to post. */
  id?: string;
  author?: string;
  created?: string;
  /** Markdown. */
  body: string;
}

export interface Ticket {
  /** Absent for tickets not yet created in Jira. */
  key?: string;
  /**
   * Jira's last-updated timestamp as of the last fetch. Informational only: never
   * diffed, merged, or pushed, and absent on pending creations.
   */
  updated?: string;
  project: string;
  type: string;
  summary: string;
  /** Editing this compiles to a workflow transition. Absent on new tickets = server default. */
  status?: string;
  /** Markdown, or null for no description. */
  description: string | null;
  /** Set by fetch when the remote ADF contains nodes outside the supported markdown subset. */
  descriptionLossy?: boolean;
  labels: string[];
  /** Parent issue key (epic parenting), "@<file-stem>" for a pending creation, or null. */
  parent: string | null;
  /** Sprint name (resolved via meta) or numeric sprint id; null = backlog. */
  sprint: string | number | null;
  /** Email address, "accountId:<id>", or null = unassigned. */
  assignee: string | null;
  priority: string | null;
  links: LinkEntry[];
  comments: CommentEntry[];
  /** Tracked custom fields, keyed by alias (field display name) or raw customfield_* id. */
  fields: Record<string, unknown>;
}

/** Base layer entry: remote state as of last fetch, plus raw data needed to compile deltas. */
export interface BaseEntry {
  key: string;
  fetchedAt: string;
  /** Jira `updated` timestamp — staleness guard for push. */
  updated: string;
  ticket: Ticket;
  raw: {
    descriptionAdf: unknown;
    sprintId: number | null;
    assigneeAccountId: string | null;
    statusId: string | null;
    /** "<type>|<to>" (as materialized in the ticket file) -> issueLink id, for deletions. */
    linkIds: Record<string, string>;
  };
}

export interface Config {
  baseUrl: string;
  email: string;
  project: string;
  boardId?: number;
  /** Built-in fields included in ticket files. */
  trackedFields: string[];
  /** Custom field aliases tracked in the `fields` object. */
  customFields: string[];
  /** Mirror declaration: `jt pull` keeps the workspace equal to this JQL slice of Jira. */
  sync?: { jql: string };
}

/** Mirror observation state (.jira/sync.json) — tool-owned, never edited by hand. */
export interface SyncState {
  /**
   * High-water `updated` mark (server clock, minus a safety overlap) from the last
   * completed scope pull; null before the first sync. Incremental pulls page the scope
   * newest-first and stop below this mark.
   */
  watermark: string | null;
  /** Keys that matched the sync JQL at the last completed pull — mirror membership. */
  scopeKeys: string[];
}

export interface MetaField {
  id: string;
  name: string;
  custom: boolean;
  schemaType?: string;
  schemaCustom?: string;
  schemaItems?: string;
}

export interface Meta {
  syncedAt: string;
  fields: MetaField[];
  issueTypes: { id: string; name: string; subtask: boolean }[];
  linkTypes: { id: string; name: string; inward: string; outward: string }[];
  priorities: { id: string; name: string }[];
  statuses: string[];
  sprints: { id: number; name: string; state: string }[];
  sprintFieldId: string | null;
  boardId: number | null;
}

export interface DeletionIntent {
  key: string;
  /** Summary at time of `jt rm` — shown in diffs and re-checked at push. */
  summary: string;
  requestedAt: string;
  committed: boolean;
}

export interface ConflictRecord {
  key: string;
  fields: string[];
  detectedAt: string;
  /** Remote values (canonical form) for the conflicting fields, for rendering. */
  remote: Record<string, unknown>;
  local: Record<string, unknown>;
}

export type TicketState =
  | "clean"
  | "modified"
  | "committed"
  | "committed+modified"
  | "new"
  | "new+committed"
  | "new+committed+modified"
  | "deleted"
  | "deleted+committed"
  | "missing"
  | "conflict";

export interface TicketStatus {
  /** Issue key, or "@<stem>" for pending creations. */
  id: string;
  state: TicketState;
  summary: string;
  detail?: string;
}

/** A compiled API operation. `$ref` placeholders (pending-creation keys) resolve at execution. */
export interface CompiledOp {
  label: string;
  kind: "create" | "update" | "transition" | "link" | "unlink" | "comment" | "delete";
  /** For creates: the "@<stem>" id this op's created key will be bound to. */
  refId?: string;
  /** Issue this op targets — key or "@<stem>". */
  issue: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** For transition ops: target status name; transition id resolved live at execution. */
  transitionTo?: string;
  /** For comment ops: the markdown source, used to reconcile local files after posting. */
  commentBody?: string;
}

export interface JournalOpResult {
  label: string;
  method: string;
  path: string;
  body?: unknown;
  status?: number;
  ok: boolean;
  response?: unknown;
  error?: string;
}

export interface JournalEntry {
  startedAt: string;
  finishedAt?: string;
  result: "success" | "partial" | "dry-run";
  ops: JournalOpResult[];
  created?: Record<string, string>;
  error?: string;
}
