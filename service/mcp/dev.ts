// Local development: the hosted MCP on http://localhost:3318/mcp against the local Supabase stack. The
// commands it hands out run this checkout's CLI with the local service's address.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listen } from "./server.ts";

const status = execSync("supabase status -o env", { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
const get = (k: string) => new RegExp(`^${k}="?([^"\\n]+)`, "m").exec(status)?.[1] ?? "";
const port = Number(process.env.PORT ?? 3318);
const url = get("API_URL").replace("127.0.0.1", "localhost");
const cliMain = fileURLToPath(new URL("../../packages/cli/dist/main.js", import.meta.url));
listen(
  {
    base: `http://localhost:${port}`,
    web: "http://localhost:3317",
    supabaseUrl: url,
    anonKey: get("ANON_KEY"),
    serviceKey: get("SERVICE_ROLE_KEY"),
    cli: `${process.execPath} ${cliMain}`,
    cliEnv: { CODESIGNFLO_SERVICE_URL: url, CODESIGNFLO_SERVICE_ANON: get("ANON_KEY"), CODESIGNFLO_SERVICE_WEB: "http://localhost:3317" },
    // CODESIGNFLO_MODE=selfhost: try the self-hosted box's behaviour (the database's own mode is app_config 'mode').
    ...(process.env.CODESIGNFLO_MODE === "selfhost" ? { selfhost: true } : {}),
  },
  port,
);
console.log(`CoDesignFlo MCP on http://localhost:${port}/mcp`);
