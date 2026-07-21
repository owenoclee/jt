/**
 * Zod schema for ticket files. Strict: unknown keys are hard errors, so a typo like
 * "sumary" fails validation instead of silently doing nothing.
 */
import { z } from "zod";
import type { Ticket } from "./types.ts";

export const LinkEntrySchema = z.strictObject({
  type: z.string().min(1),
  to: z.string().min(1),
});

export const CommentEntrySchema = z.strictObject({
  id: z.string().optional(),
  author: z.string().optional(),
  created: z.string().optional(),
  body: z.string(),
});

export const TicketSchema = z.strictObject({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/, "not a valid issue key").optional(),
  project: z.string().min(1),
  type: z.string().min(1),
  summary: z.string().min(1),
  status: z.string().min(1).optional(),
  description: z.string().nullable(),
  descriptionLossy: z.boolean().optional(),
  labels: z.array(z.string().min(1)),
  parent: z.string().nullable(),
  sprint: z.union([z.string().min(1), z.number().int()]).nullable(),
  assignee: z.string().min(1).nullable(),
  priority: z.string().min(1).nullable(),
  links: z.array(LinkEntrySchema),
  comments: z.array(CommentEntrySchema),
  fields: z.record(z.string(), z.unknown()),
});

export const ConfigSchema = z.strictObject({
  baseUrl: z.string().url().transform((u) => u.replace(/\/+$/, "")),
  email: z.string().email(),
  project: z.string().min(1),
  boardId: z.number().int().optional(),
  trackedFields: z.array(z.string()),
  customFields: z.array(z.string()),
  sync: z.strictObject({ jql: z.string().min(1) }).optional(),
});

export function parseTicket(data: unknown, source: string): Ticket {
  const result = TicketSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid ticket file ${source}:\n${issues}`);
  }
  return result.data as Ticket;
}

export function ticketJsonSchema(): unknown {
  return z.toJSONSchema(TicketSchema);
}
