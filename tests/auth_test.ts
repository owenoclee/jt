import { assert, assertEquals, assertRejects } from "@std/assert";
import { JiraApiError, JiraClient } from "../src/jira/client.ts";

/** Serves one canned failure, so the client's error text can be read back. */
async function withServer(
  respond: (req: Request) => Response,
  fn: (client: JiraClient) => Promise<void>,
): Promise<void> {
  const server = Deno.serve({ port: 0, onListen: () => {} }, respond);
  const port = (server.addr as Deno.NetAddr).port;
  try {
    await fn(
      new JiraClient(`http://127.0.0.1:${port}`, "you@example.com", "t", "env:JIRA_API_TOKEN"),
    );
  } finally {
    await server.shutdown();
  }
}

/**
 * The bodies and headers below are copies of what a live Jira Cloud site returned to a
 * request carrying a bad API token — including the status codes it chose, which are
 * the reason status-based detection is not enough.
 */
Deno.test("a 401 is reported as an expired token, whatever Jira's body says", async () => {
  await withServer(
    () =>
      new Response(JSON.stringify("Client must be authenticated to access this resource."), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    async (client) => {
      const err = await assertRejects(() => client.get("/rest/api/3/myself"), JiraApiError);
      assert(err.message.includes("most likely expired or been revoked"), err.message);
      assert(err.message.includes("env:JIRA_API_TOKEN"), err.message);
      assert(err.message.includes("id.atlassian.com/manage-profile/security/api-tokens"));
      assert(err.message.includes("you@example.com"), err.message);
    },
  );
});

Deno.test("a 404 whose auth silently failed is an auth error, not a missing issue", async () => {
  await withServer(
    () =>
      // Verbatim from a live site: a rejected token turns every issue into a 404,
      // localized to the site's language.
      new Response(
        JSON.stringify({ errorMessages: ["事务不存在或者您没有查看的权限。"], errors: {} }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "x-seraph-loginreason": "AUTHENTICATED_FAILED",
          },
        },
      ),
    async (client) => {
      const err = await assertRejects(() => client.get("/rest/api/3/issue/SBX-1"), JiraApiError);
      assert(err.message.includes("most likely expired or been revoked"), err.message);
      assert(err.message.includes("not a deleted ticket"), err.message);
      // Jira's own words survive — they are the evidence, not the explanation.
      assert(err.message.includes("事务不存在"), err.message);
    },
  );
});

Deno.test("a 200 whose auth silently failed is an error, not an empty project", async () => {
  await withServer(
    () =>
      // A live site answers a search from a rejected token with a plain, empty 200 —
      // indistinguishable from "every ticket was deleted" unless the header is read.
      new Response(JSON.stringify({ issues: [], isLast: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-seraph-loginreason": "AUTHENTICATED_FAILED",
        },
      }),
    async (client) => {
      const err = await assertRejects(
        () => client.post("/rest/api/3/search/jql", { jql: "project = SBX" }),
        JiraApiError,
      );
      assertEquals(err.status, 200);
      assert(err.message.includes("most likely expired or been revoked"), err.message);
      assert(err.message.includes("empty project"), err.message);
    },
  );
});

Deno.test("a valid response carries no auth header and is returned untouched", async () => {
  await withServer(
    () =>
      new Response(JSON.stringify({ issues: [{ key: "SBX-1" }], isLast: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    async (client) => {
      const res = await client.post("/rest/api/3/search/jql", { jql: "project = SBX" }) as {
        issues: { key: string }[];
      };
      assertEquals(res.issues[0].key, "SBX-1");
    },
  );
});

Deno.test("an HTML login page in a 401 body is flattened, not dumped", async () => {
  await withServer(
    () =>
      new Response("<html><head><title>Log in</title></head><body><h1>Log in</h1></body></html>", {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }),
    async (client) => {
      const err = await assertRejects(() => client.get("/rest/api/3/myself"), JiraApiError);
      assert(!err.message.includes("<html>"), err.message);
      assert(err.message.includes("Log in"), err.message);
      assert(err.message.includes("most likely expired or been revoked"), err.message);
    },
  );
});

Deno.test("a 403 is reported as permission, not as an expired token", async () => {
  await withServer(
    () =>
      new Response(JSON.stringify({ errorMessages: ["You do not have permission"] }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    async (client) => {
      const err = await assertRejects(() => client.delete("/rest/api/3/issue/TST-1"), JiraApiError);
      assert(err.message.includes("not permitted"), err.message);
      assert(!err.message.includes("most likely expired"), err.message);
    },
  );
});

Deno.test("requests ask for English so failures are not localized", async () => {
  let seen: string | null = null;
  await withServer(
    (req) => {
      seen = req.headers.get("Accept-Language");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
    async (client) => {
      await client.get("/rest/api/3/myself");
    },
  );
  assert(seen === "en", `Accept-Language was ${seen}`);
});
