import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { diffTickets } from "../src/diff.ts";
import { makeRefContext } from "../src/refs.ts";
import { renderDiffEntries } from "../src/render/render.ts";
import { renderPage, renderTicketDelta, type ReviewPageModel } from "../src/review/html.ts";
import { makeBaseEntry, makeConfig, makeTicket, tempStore } from "./helpers.ts";

function setup() {
  const store = tempStore();
  const config = makeConfig();
  store.writeBase(makeBaseEntry(makeTicket({ key: "TST-100", summary: "The epic of legends" })));
  store.writeWorking("@new-epic", makeTicket({ summary: "A pending epic" }));
  return { store, config, refs: makeRefContext(store, config) };
}

Deno.test("refs: keys resolve via base, @names via working; only keys get URLs", () => {
  const { refs } = setup();
  assertEquals(refs.summaryOf("TST-100"), "The epic of legends");
  assertEquals(refs.summaryOf("@new-epic"), "A pending epic");
  assertEquals(refs.summaryOf("TST-999"), null);
  assertEquals(refs.browseUrl("TST-100"), "https://example.atlassian.net/browse/TST-100");
  assertEquals(refs.browseUrl("@new-epic"), null);
});

Deno.test("web diff: parent and link refs link to Jira and carry summaries", () => {
  const { refs } = setup();
  const from = makeTicket({ key: "TST-1", parent: null });
  const to = makeTicket({
    key: "TST-1",
    parent: "TST-100",
    links: [{ type: "blocks", to: "TST-100" }],
  });
  const html = renderTicketDelta(from, to, refs);
  assertStringIncludes(html, 'href="https://example.atlassian.net/browse/TST-100"');
  assertStringIncludes(html, "The epic of legends");
});

Deno.test("web page: header ids link to Jira; pending creations don't", () => {
  const { config } = setup();
  const card = { unchangedSinceReview: false, diffHtml: "", opsJson: "" };
  const model: ReviewPageModel = {
    mode: "readonly",
    title: "t",
    target: { baseUrl: config.baseUrl, project: config.project },
    tickets: [
      { id: "TST-1", summary: "Some ticket", kind: "update", ...card },
      { id: "@new-epic", summary: "A pending epic", kind: "create", ...card },
    ],
    commits: [],
    sinceReview: null,
    nonce: "",
  };
  const page = renderPage(model);
  assertStringIncludes(page, '<a class="ref" href="https://example.atlassian.net/browse/TST-1"');
  assert(!page.includes("browse/@new-epic"));
});

Deno.test("terminal diff: parent and link refs carry summaries", () => {
  const { refs } = setup();
  const from = makeTicket({ key: "TST-1", parent: null });
  const to = makeTicket({
    key: "TST-1",
    parent: "TST-100",
    links: [{ type: "blocks", to: "TST-100" }],
  });
  const text = renderDiffEntries("TST-1", "Some ticket", diffTickets(from, to), refs);
  assertStringIncludes(text, "TST-100 (The epic of legends)");
  assertStringIncludes(text, "+ blocks TST-100 (The epic of legends)");
});
