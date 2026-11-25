// How to connect each coding agent to the hosted MCP (Streamable HTTP + OAuth sign-in): what the developer
// sees under "Connect your coding agent". Every agent here runs commands in the app's folder, which `sync`
// needs (it renders Storybook on the developer's machine).

export type Step = { text: string; code?: string };
export type Agent = { id: string; name: string; steps: Step[]; install?: { label: string; href: string } };

const json = (v: unknown) => JSON.stringify(v, null, 2);

export function agents(url: string): Agent[] {
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      steps: [
        { text: "Add CoDesignFlo for all your folders:", code: `claude mcp add --transport http --scope user codesignflo ${url}` },
        { text: "In Claude Code, run /mcp, choose codesignflo and sign in (the browser opens; continue with GitHub and click Connect)." },
      ],
    },
    {
      id: "cursor",
      name: "Cursor",
      install: {
        label: "Add to Cursor",
        href: `cursor://anysphere.cursor-deeplink/mcp/install?name=codesignflo&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}`,
      },
      steps: [
        { text: "Or add it to ~/.cursor/mcp.json (all projects):", code: json({ mcpServers: { codesignflo: { url } } }) },
        { text: "In Cursor Settings → MCP, click Connect next to codesignflo to sign in." },
      ],
    },
    {
      id: "vscode",
      name: "VS Code (Copilot)",
      install: {
        label: "Add to VS Code",
        href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "codesignflo", type: "http", url }))}`,
      },
      steps: [
        { text: "Or from a terminal:", code: `code --add-mcp '${JSON.stringify({ name: "codesignflo", type: "http", url })}'` },
        { text: "Start the server from the MCP: List Servers command and sign in when asked; use Copilot Chat in Agent mode." },
      ],
    },
    {
      id: "windsurf",
      name: "Windsurf",
      steps: [
        { text: "Add it to ~/.codeium/windsurf/mcp_config.json:", code: json({ mcpServers: { codesignflo: { serverUrl: url } } }) },
        { text: "In Cascade's MCP panel, refresh and sign in to codesignflo." },
      ],
    },
    {
      id: "codex",
      name: "Codex CLI",
      steps: [
        { text: "Add it, then sign in:", code: `codex mcp add codesignflo --url ${url}\ncodex mcp login codesignflo` },
        { text: "Or in ~/.codex/config.toml:", code: `[mcp_servers.codesignflo]\nurl = "${url}"` },
      ],
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      steps: [
        { text: "Add it for all your folders:", code: `gemini mcp add --transport http --scope user codesignflo ${url}` },
        { text: "In Gemini CLI, sign in:", code: "/mcp auth codesignflo" },
      ],
    },
    {
      id: "other",
      name: "Other",
      steps: [
        {
          text: "Any coding agent that supports remote MCP servers (Streamable HTTP) with sign-in (OAuth) and can run commands in your project. The server's address:",
          code: url,
        },
      ],
    },
  ];
}

/** What to say to the agent once it's connected (the same for every agent). */
export const FIRST_PROMPT = "Connect this app to CoDesignFlo";
