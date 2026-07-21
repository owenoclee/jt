/**
 * Resolving ticket references (issue keys or "@name" pending creations) to display
 * info from the local layers — no network. Renderers take a RefContext so a reference
 * to another ticket (parent, link target) can show that ticket's summary and link to
 * Jira instead of a bare key.
 */
import type { Store } from "./store.ts";
import type { Config } from "./types.ts";

export interface RefContext {
  /** Display summary for a referenced ticket, if any local layer knows it. */
  summaryOf(id: string): string | null;
  /** Absolute Jira browse URL for a real issue key; null for pending creations. */
  browseUrl(id: string): string | null;
}

/** For render paths with no workspace at hand: references stay bare keys. */
export const NO_REFS: RefContext = {
  summaryOf: () => null,
  browseUrl: () => null,
};

export function makeRefContext(store: Store, config: Config): RefContext {
  return {
    summaryOf: (id) =>
      id.startsWith("@")
        ? store.readWorking(id)?.ticket.summary ?? store.readCommitted(id)?.ticket.summary ?? null
        : store.readBase(id)?.ticket.summary ?? store.readWorking(id)?.ticket.summary ?? null,
    browseUrl: (id) => (id.startsWith("@") ? null : `${config.baseUrl}/browse/${id}`),
  };
}
