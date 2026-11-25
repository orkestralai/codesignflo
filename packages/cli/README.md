# CoDesignFlo

**Pull requests for design.** CoDesignFlo keeps a Figma mirror of your app ("Live") in step with your code. Your designer proposes changes in Figma, and your coding agent builds them in the code.

This package is CoDesignFlo's command-line tool. You rarely run it by hand. Your coding agent connects to CoDesignFlo's MCP server and runs these commands for you. Everything also works from a terminal.

- Website and sign-in: <https://codesignflo.com>
- Documentation: <https://codesignflo.com/#/docs/developers>
- The Figma plugin, for designers: see the designers' guide in the docs

## How it works

CoDesignFlo connects the developer's machine and the designer's Figma file through the CoDesignFlo service. Nobody has to be online at the same time.

**1. Code → Figma (Live).** `sync` builds your Storybook and opens every story in a headless browser on your machine. It reads what the browser drew (layout, text, styles, images) and compiles it into Figma layers: components with their variants, and full pages. That update is uploaded and applied to the **Live** page the next time the Figma file is open with the plugin. Your source code is never uploaded.

**2. Figma → code (proposals).** The designer claims a component or page in Live, changes their copy, and sends it with a note. CoDesignFlo compares the copy with the version they started from and lists exactly what changed (properties, text, layers, sizes, colours in your tokens). Your agent gets those changes as instructions and builds them any way it likes.

**3. Closing.** Every sync checks each open design against the code ("2 of 3 of the designer's changes in the code", then "looks done"). When Live, rebuilt from the code, matches the design, the design closes and the designer is told.

```
 your code ──sync──▶ CoDesignFlo ──plugin──▶ Figma "Live"
     ▲                                          │ claim, edit, send
     └──── agent builds it ◀── proposal ◀───────┘
```

## Requirements

- A React app in a git repository, with at least one commit
- Storybook, with stories for your components (and `Pages/…` stories for your pages)
- Node.js 22 or newer
- Optional: a DTCG design-tokens JSON file, so Live binds colours and sizes to your tokens
- Optional: a coding agent that supports remote MCP servers (Claude Code, Cursor, VS Code, Codex, Gemini CLI, Windsurf…)

## Quick start with a coding agent

Add CoDesignFlo's MCP server once, for all your folders. With Claude Code:

```bash
claude mcp add --transport http --scope user codesignflo https://codesignflo.vercel.app/mcp
```

Run `/mcp` in Claude Code, choose `codesignflo` and sign in. Your browser opens; continue with GitHub and click **Connect**. For other agents, see the docs page "Connecting your agent".

Then, in your app's folder, tell your agent:

> Connect this app to CoDesignFlo

It identifies the repository, asks which branch should update Live, writes `.codesignflo/config.json` (commit it) and offers to invite your designer. After that, these prompts cover the day-to-day work:

| Say | What happens |
|---|---|
| "sync" | Storybook is rendered and Live updated; open designs are checked against the code |
| "what did the designer send?" | What waits on you, and how Live stands |
| "review the designs with me" | One design at a time, with a review brief; your decision is recorded |
| "build the approved designs" | Each design is implemented, committed and synced until it looks done |
| "update Live on every commit" | A git hook syncs after each commit on the Live branch |

The agent runs this package with `npx`, so there's nothing to install.

## Using it from a terminal

```bash
npx @codesignflo/cli login            # sign in (opens the browser)
npx @codesignflo/cli init --cloud     # connect this app (--project <id> | --new)
npx @codesignflo/cli sync             # render, check and update Live
```

| Command | What it does |
|---|---|
| `login` / `whoami` / `logout` | Sign in, see who you are, revoke this machine's sign-in (`--everywhere`) |
| `init --cloud` | Connect this app to a project (`--project <id>` or `--new`) |
| `status` | What waits on you, and each component's state (`--all`) |
| `sync` | Render Storybook, check open designs, update Live (`--only a,b`; `--preview` on a feature branch) |
| `proposal <component>` | A design as implementation instructions (`--json`) |
| `deliver <component>` | Apply a ready design with Claude Code and commit it (`--track`: you implement it) |
| `ask <component> "<question>"` | Send a design back to the designer with a question |
| `resolve <component> --design \| --code "<why>"` | Settle a clash between the designer's copy and code changed meanwhile |
| `stories` | Components that have no story yet (`--json`) |
| `verify` | Compare Live with the code, variant by variant |
| `name` | Give unnamed elements semantic layer names (`data-cdf`) with Claude Code |
| `invite <email>` | Invite someone (`--designer`, `--developer` or `--admin`; `--resend`) |
| `people` | Who is in the project |
| `live-branch [<name>]` | Show or set the branch that updates Live |
| `branch [connect \| disconnect] [<name>]` | Give a feature branch a lane beside Live, updated by every sync on it (without arguments: the connected ones) |
| `hook install \| remove` | Update Live on every commit to the Live branch |
| `mcp` | Run the MCP server locally over stdio |
| `connect <box URL> \| --cloud` | Use a self-hosted CoDesignFlo box (or go back to the cloud) |
| `plugin build --server <box URL>` | Build the Figma plugin for a self-hosted box (`--out <dir>`) |
| `version` | Print the version |

## Stories for Live

Each story group becomes a component in Live, and each story becomes one of its variants. Stories titled `Pages/…` become full pages. Live renders each story at its Storybook viewport (or 1200×900), with a fixed clock (1 January 2026). You can tune a story with parameters:

```ts
export const Dashboard = {
  parameters: {
    codesignflo: {
      size: { width: 1440, height: 900 }, // the frame size in Live
      fullHeight: true,                   // an app shell 100vh tall whose panel scrolls
      date: "2026-03-01",                 // for fixtures with real dates
    },
  },
};
```

## Self-hosting

A team that runs its own CoDesignFlo box (one address, such as `https://box.example.com`, `http://localhost:8080` or a Tailscale name):

```bash
npx @codesignflo/cli connect https://box.example.com        # this machine uses the box (and trusts it from now on)
npx @codesignflo/cli login                                  # sign in on the box
npx @codesignflo/cli plugin build --server https://box.example.com   # the Figma plugin for the box: a folder and a zip
```

Designers import the folder's `manifest.json` in the Figma desktop app (Plugins → Development → Import plugin from manifest). `connect` prints the box's MCP address for coding agents. `connect --cloud` goes back to the cloud.

## Teams and roles

A project has **designers**, **developers** and **admins**. A designer's decisions (claiming, sending designs, accepting) and a developer's decisions (reviewing, building, resolving) are each recorded only from their own side. Someone who both designs and codes should be an admin. An admin makes them one by inviting them again with `--admin`.

## Privacy

Sync runs on your machine. Your source code stays there; only what Live needs (the compiled Figma layers and images of what your stories draw) is uploaded. See the privacy policy at <https://codesignflo.com>.

## Support

Something not working? Ask your agent to report it (CoDesignFlo's `report_issue` tool), or write to contact@orkestralai.com.

MIT licensed. © 2026 OrkestralAI UG (haftungsbeschränkt).
