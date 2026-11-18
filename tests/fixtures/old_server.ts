/**
 * A review server that says it is from an older jt — what is left running after an
 * upgrade. serve_test.ts starts it to check that the current jt replaces it.
 */
import { dirname } from "@std/path";
import { serverStatePath } from "../../src/commands/serve.ts";
import { createHub } from "../../src/review/hub.ts";

const hub = createHub({ version: "0.0.1" });
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => hub.handle(req));
Deno.mkdirSync(dirname(serverStatePath()), { recursive: true });
Deno.writeTextFileSync(
  serverStatePath(),
  JSON.stringify({ pid: Deno.pid, port: server.addr.port, version: "0.0.1", startedAt: new Date().toISOString() }),
);
Deno.addSignalListener("SIGTERM", () => Deno.exit(0));
await server.finished;
