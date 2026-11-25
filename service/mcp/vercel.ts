// The deployment's entry (Vercel, Node runtime): the same handler as the local server, configured from the
// environment. Mounted at each of the MCP's paths (see scripts/vercel-build.mjs).
import type { IncomingMessage, ServerResponse } from "node:http";
import { configFromEnv, handle, type ServerConfig } from "./server.ts";

let cfg: ServerConfig | null = null;

export default async function (req: IncomingMessage, res: ServerResponse) {
  try {
    cfg ??= configFromEnv();
    await handle(cfg, req, res);
  } catch (e) {
    // The details go to the logs, not to whoever called.
    console.error(`${req.method} ${req.url?.split("?")[0]}:`, e);
    if (!res.headersSent)
      res
        .writeHead(500, { "content-type": "application/json", "x-content-type-options": "nosniff" })
        .end(JSON.stringify({ error: "server_error", message: "something went wrong on our side — try again in a moment" }));
  }
}
