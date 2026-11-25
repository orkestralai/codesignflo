// The documentation: a docs site in the usual shape (sections in a sidebar, one topic per page, "On this page",
// search, previous / next). Public, signed in or not. Routes: #/docs/<page>[/<section>].
import { agents } from "./agents.ts";
import { FREE_SENDS, LAUNCH, launchOn, SEAT_EUR, seatPrice, VAT_NOTE } from "./pricing.ts";

export type DocCtx = { mcpUrl: string };
type Page = { slug: string; title: string; summary: string; body: (c: DocCtx) => string };
type Group = { title: string; pages: Page[] };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ——— Building blocks ———
const h2 = (id: string, t: string) => `<h2 id="${id}"><a class="dx-anchor" href="#" data-doc-sec="${id}" aria-label="Link to this section">#</a>${t}</h2>`;
const h3 = (t: string) => `<h3>${t}</h3>`;
const ul = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const steps = (items: string[]) => `<ol class="dx-steps">${items.map((i) => `<li>${i}</li>`).join("")}</ol>`;
const note = (kind: "note" | "tip" | "warn", title: string, body: string) =>
  `<div class="dx-callout dx-${kind}"><b>${title}</b><div>${body}</div></div>`;
const code = (text: string, lang = "") =>
  `<div class="dx-code"><div class="dx-code-bar"><span>${lang}</span><button type="button" class="dx-copy" data-copy>Copy</button></div><pre><code>${esc(text)}</code></pre></div>`;
const table = (head: string[], rows: string[][]) =>
  `<div class="dx-table"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
/** A label as it appears in the plugin or the web app. */
const ui = (t: string) => `<span class="dx-ui">${t}</span>`;
const c = (t: string) => `<code>${esc(t)}</code>`;
const link = (slug: string, t: string, sec?: string) => `<a href="#/docs/${slug}${sec ? `/${sec}` : ""}">${t}</a>`;
const cards = (items: [string, string, string][]) =>
  `<div class="dx-cards">${items.map(([slug, t, d]) => `<a class="dx-card" href="#/docs/${slug}"><b>${t}</b><span>${d}</span></a>`).join("")}</div>`;

// ——— The pages ———
const GROUPS: Group[] = [
  {
    title: "Getting started",
    pages: [
      {
        slug: "overview",
        title: "Introduction",
        summary: "What CoDesignFlo is, who it's for, and where to start.",
        body: () => `
<p class="dx-lead">CoDesignFlo is <b>pull requests for design</b>. It keeps a team's Figma file in sync with its codebase, so designers and coding agents work from the same thing.</p>
${h2("what", "What it does")}
${ul([
  `<b>Your app, live in Figma.</b> Every component and page of the app is drawn in the designer's Figma file exactly as the browser shows it, and redrawn when the code changes. That page is called ${ui("Live")}.`,
  `<b>Designs as instructions.</b> The designer changes a copy of a component or page and sends it. The developer's coding agent receives exactly what changed, in the app's own components and tokens, and builds it.`,
  "<b>Closing the loop.</b> Each time the code is synced, CoDesignFlo checks how much of each design the code now does. When the app matches the design, the design closes and Live shows the result.",
])}
${h2("who", "Who it's for")}
${table(
  ["You are", "You use", "You need"],
  [
    ["A designer", "The CoDesignFlo plugin in Figma", "Figma (any plan, including free). No code, no terminal."],
    ["A developer", "Your coding agent (Claude Code, Cursor, VS Code, Codex, Gemini CLI, Windsurf…), or the CLI", "A React app with Storybook in a git repository. No Figma."],
  ],
)}
${h2("start", "Where to start")}
${cards([
  ["designers", "Quickstart for designers", "Install the plugin, start a project and invite your developer."],
  ["developers", "Quickstart for developers", "Connect your coding agent and put your app in Figma."],
  ["how-it-works", "How it works", "The loop from code to Figma and back, step by step."],
  ["concepts", "Key concepts", "Live, proposals, claims, sync, previews: the words used in these docs."],
])}
${h2("pricing", "Pricing")}
<p>Developers are free. Designers: ${seatPrice()}, after their first ${FREE_SENDS} sends to dev, which are free. A seat is the designer's and works in every project; they pay for it, or someone pays for them. See ${link("billing", "Pricing and billing")}.</p>`,
      },
      {
        slug: "how-it-works",
        title: "How it works",
        summary: "The full loop: code to Figma, Figma to code, and closing.",
        body: () => `
<p class="dx-lead">CoDesignFlo connects two places that never talk to each other directly: the developer's machine and the designer's Figma file. Everything goes through the CoDesignFlo service, so nobody has to be online at the same time.</p>
${h2("code-to-figma", "1. Code → Figma: Live")}
${steps([
  `The developer (or their coding agent) runs ${ui("sync")} in the app's folder.`,
  "Sync builds the app's Storybook and opens every story in a headless browser on the developer's machine.",
  "For each story it reads what the browser drew (layout, text, styles, images) and compiles it into Figma layers: components with their variants, and full pages.",
  "That compiled update is uploaded to the CoDesignFlo service. Your source code is never uploaded.",
  `The next time the Figma file is open with the plugin, the plugin applies the update to the ${ui("Live")} page. If the file is open right now, sync waits for it and reports how it went.`,
])}
${note("note", "Why the file must be open", "Only a running plugin can change a Figma file (this is how Figma works on every plan). Updates wait safely on the service until someone opens the file with the plugin.")}
${h2("figma-to-code", "2. Figma → code: proposals")}
${steps([
  `The designer ${ui("Claim")}s a component or page in Live. A copy appears on the ${ui("Proposals")} page.`,
  "They change the copy any way they like, then send it with a note.",
  "CoDesignFlo compares the copy with the version they started from and lists exactly what changed: properties, text, layers, sizes, colours (in the app's tokens).",
  "The developer's coding agent receives those changes as instructions, builds them in the code any way it likes, commits, and syncs.",
])}
${h2("closing", "3. Closing")}
<p>Every sync checks each open design against the code: "2 of 3 of the designer's changes in the code", then "looks done". When Live, rebuilt from the code, matches the design, the design closes, its copy moves to the Archive, and the designer is told.</p>
${h2("diagram", "At a glance")}
${table(
  ["Step", "Who", "Where", "What happens"],
  [
    ["Sync", "Developer / agent", "Their machine", "Storybook rendered, Live update uploaded"],
    ["Apply", "Plugin", "Figma", "Live page redrawn from the update"],
    ["Claim & send", "Designer", "Figma", "Copy changed, sent as a proposal"],
    ["Build", "Developer / agent", "Their code", "Proposal implemented, committed"],
    ["Check", "Sync", "Their machine", "Progress measured; done designs close"],
  ],
)}`,
      },
      {
        slug: "designers",
        title: "Quickstart for designers",
        summary: "From installing the plugin to your first design sent, in ten minutes.",
        body: () => `
<p class="dx-lead">You'll install the plugin, start a project for your Figma file, invite your developer, and send your first design.</p>
${note("tip", "Try the demo first", `In a new, empty Figma file, run the plugin, sign in and choose ${ui("Try a demo")}: a small shop's website arrives in Live with Alex, a simulated developer, and a step-by-step guide walks you through the whole loop in about ten minutes. Its sends don't count toward your free sends; ${ui("Quit demo")} removes everything it made.`)}
${h2("install", "1. Install the plugin")}
<p>CoDesignFlo is a plugin for the Figma desktop app. Any Figma plan works, including the free one. Until it's in Figma Community, install it from the download:</p>
${steps([
  `<a href="/plugin.zip" download>Download the plugin</a> and unzip it somewhere it can stay (for example ${c("Documents/CoDesignFlo")}).`,
  `In the Figma desktop app, open any design file, then ${ui("Plugins › Development › Import plugin from manifest…")} and pick ${c("manifest.json")} in that folder.`,
  `Run it from ${ui("Plugins › Development › CoDesignFlo")}.`,
])}
${note("tip", "Updates", "Download it again and replace the files in the same folder. No need to import it again: the next time you open the plugin, it's the new version.")}
${h2("sign-in", "2. Sign in")}
${steps([
  `Open your Figma file and run the plugin. Click ${ui("Sign in")}.`,
  "Your browser opens. Sign in the way the page offers (such as Google or a link by email) and approve the code the plugin shows. Nothing is typed into Figma.",
  `Back in Figma, the plugin says ${ui("Signed in to CoDesignFlo")}.`,
])}
${h2("project", "3. Start a project")}
<p>If a developer already invited you, the plugin finds your project by itself: choose ${ui("Use this file")}. Otherwise give the project a name and click ${ui("Start project")}. The plugin sets up the file (see ${link("figma-file", "Your Figma file")}).</p>
${h2("invite", "4. Invite your developer")}
<p>Open ${ui("People")}, type your developer's email and click ${ui("Send invite")}. They get an email telling them how to connect their coding agent. ${ui("Your developer connects the code")} shows until they do; then ${ui("Your app arrives in Live")}, after their first sync.</p>
${h2("first", "5. Send your first design")}
${steps([
  `On the Live page, select a component or page and click ${ui("Claim")}. A copy goes to ${ui("Proposals › Active")}.`,
  "Change the copy freely: colours, sizes, text, layout, new layers.",
  `Click ${ui("Ready for dev")}, check the list of changes the plugin found, add a note, and ${ui("Send to developer")}.`,
  "Follow its progress on the row: reviewed, being built, then done in code.",
])}
${h2("next", "Next")}
${cards([
  ["plugin-panel", "The plugin panel", "Everything the panel shows and every button."],
  ["proposing-changes", "Proposing a change", "Claiming, editing, sending, taking back."],
  ["design-system", "Your design system", "Link your components to the code's."],
])}`,
      },
      {
        slug: "developers",
        title: "Quickstart for developers",
        summary: "Connect your coding agent, link your repository, and put your app in Figma.",
        body: (x) => `
<p class="dx-lead">You'll add CoDesignFlo to your coding agent, connect your app, and run the first sync. You don't need Figma.</p>
${h2("requirements", "Before you start")}
${ul([
  "A React app in a git repository, with at least one commit.",
  `Storybook, with stories for your components (see ${link("stories", "Writing stories for Live")}).`,
  "Node.js on your machine (sync renders Storybook locally).",
  "A coding agent that supports remote MCP servers, or a terminal for the CLI.",
])}
${h2("add", "1. Add CoDesignFlo to your agent")}
<p>With Claude Code:</p>
${code(`claude mcp add --transport http --scope user codesignflo ${x.mcpUrl}`, "bash")}
<p>Then run ${c("/mcp")} in Claude Code, choose ${c("codesignflo")} and sign in (the browser opens; continue with GitHub and click ${ui("Connect")}). Other agents: ${link("connect", "Connecting your agent")}.</p>
${h2("connect", "2. Connect your app")}
<p>In your app's folder, tell your agent:</p>
${code("Connect this app to CoDesignFlo", "prompt")}
<p>It identifies the repository, asks which branch should update Live, writes ${c(".codesignflo/config.json")} (commit it), and offers to invite your designer. If your designer started the project from Figma and invited you, it offers to connect your code to their project instead. Details: ${link("setup", "Setting up a project")}.</p>
${h2("sync", "3. Sync")}
<p>Ask your agent to <b>sync</b>. It runs a command in your app's folder that builds Storybook, renders every story and uploads Live. The first sync takes a few minutes; later ones are faster.</p>
${note("tip", "Every commit, automatically", `Ask your agent to "update Live on every commit". See ${link("auto-update", "Live on every commit")}.`)}
${h2("build", "4. Build what the designer sends")}
<p>Ask "what did the designer send?" (${c("status")}), then "review the designs with me" or "build the approved designs". See ${link("reviewing", "Reviewing designs")} and ${link("building", "Building designs")}.</p>`,
      },
      {
        slug: "concepts",
        title: "Key concepts",
        summary: "The words used across CoDesignFlo, defined once.",
        body: () => `
${h2("live", "Live")}
<p>A page in the designer's Figma file that shows the app as the code draws it: ${ui("Components")} (each component with its variants), ${ui("Pages")} (each page of the app) and ${ui("Screenshots")} (the browser's picture of each page, to compare). Live is generated from the code and locked against accidental edits.</p>
${h2("live-branch", "Live branch")}
<p>The git branch whose commits update Live, usually ${c("main")}. Syncs on other branches check progress, and on a connected branch update its ${link("previews", "lane")}.</p>
${h2("proposal", "Proposal")}
<p>A designer's change to an existing component or page: a copy on the ${ui("Proposals")} page, compared with the version it started from. When sent, it is <b>ready for dev</b>.</p>
${h2("new-design", "New design")}
<p>A component or page that doesn't exist in the code yet, drawn anywhere in the file and sent with ${ui("Send new design")}.</p>
${h2("claim", "Claim")}
<p>Taking a component or page to work on. Only one designer can claim the same thing at a time; others see who has it.</p>
${h2("sync", "Sync")}
<p>The developer-side step that renders Storybook, uploads Live (on the Live branch, with everything committed) and checks every open design against the code.</p>
${h2("kept-as-design", "Kept as design")}
<p>A part of a design the code doesn't do the same way, which the team agrees to keep as the designer drew it in Live, instead of following the code.</p>
${h2("design-system", "Design System page")}
<p>An optional page holding the designer's own components, each linked to the code's. Live then uses them. See ${link("design-system", "Your design system")}.</p>
${h2("preview", "Branch lane")}
<p>A feature branch a developer connected, shown in Figma beside Live in a ${ui("Branch: name")} section: what differs from Live, with the designs it builds marked. Every sync on the branch updates it; it goes when the branch is merged.</p>
${h2("designer-lane", "Your lane")}
<p>Your section on the ${ui("Proposals")} page (${ui("Ana — active")}): the copies you claimed, and how each is coming along in the code.</p>
${h2("roles", "Roles")}
${table(
  ["Role", "Can"],
  [
    ["Designer", "Claim, send designs, answer questions, invite designers and developers."],
    ["Developer", "Connect the code, sync, review and build designs, invite designers and developers."],
    ["Admin", "Everything above, plus invite admins, rename the project and change its settings."],
    ["Owner", "The person who started the project. Pays for its designers (see Pricing)."],
  ],
)}`,
      },
    ],
  },
  {
    title: "For designers",
    pages: [
      {
        slug: "figma-file",
        title: "Your Figma file",
        summary: "The pages CoDesignFlo adds, what each holds, and what it never touches.",
        body: () => `
<p class="dx-lead">CoDesignFlo adds up to three pages to your file. Figma's free plan allows three pages, so it fits there too. Your own pages stay exactly as they are.</p>
${h2("live", "Live")}
${table(
  ["Section", "Holds", "Changed by"],
  [
    [ui("Components"), "Every component of the app, with its variants, as the code renders it.", "Only the code (each sync)"],
    [ui("Pages"), "Every page of the app, as the browser draws it.", "Only the code"],
    [ui("Screenshots"), "The browser's screenshot of each page, beside it, to compare.", "Only the code"],
    [ui("Branch: name"), "A branch lane: a feature branch's changes before it's merged, updated at each sync on it. Items built from a design say whose and how far (\"Ana's design · 2 of 3 changes in the code →\"); the link goes to her copy.", "Only the code"],
  ],
)}
${note("warn", "Live is locked", `Live is generated: anything changed by hand on it is replaced at the next update. To change something, ${ui("Claim")} it and work on the copy.`)}
${h2("proposals", "Proposals")}
${table(
  ["Section", "Holds"],
  [
    [ui("Ana — active"), "Your lane, one per designer: the copies you're working on, and those sent and waiting to be built. One being built on a branch says so beside it (\"Being built on feat/checkout · 2 of 3 →\"); the link goes to it in that branch's lane."],
    [ui("Ana — screenshots"), "A picture of each copy's page, for reference."],
    [ui("Archive"), "Copies whose design is done in code."],
  ],
)}
${h2("design-system", "Design System (optional)")}
<p>Your own components, linked to the code's. Created only when you ask for it (${ui("Create the Design System page")}). See ${link("design-system", "Your design system")}.</p>
${h2("untouched", "What CoDesignFlo never touches")}
${ul(["Your own pages and frames.", "Your team libraries.", "Anything outside the pages above."])}
${h2("similarity", "\"84% like your design\"")}
<p>Pages built on your design show how close the app is to it. It's a guide for you to judge, not a target the developer must hit.</p>`,
      },
      {
        slug: "plugin-panel",
        title: "The plugin panel",
        summary: "Needs you, Your work, In sync, People, the Guide: what each part shows and does.",
        body: () => `
${h2("needs-you", "Needs you")}
<p>What waits for you, newest first:</p>
${table(
  ["Row", "Means", "What you can do"],
  [
    [ui("New in code"), "The developers built something without a design.", `${ui("Looks good")} (it joins Live as is), ${ui("No design needed")}, or ${ui("Claim")} it to redesign it.`],
    [ui("Updated"), "The code changed something you'd designed.", `Look at it in Live, then ${ui("Got it")}.`],
    [ui("The developer has a question"), "A developer sent a design back with a question.", `Type ${ui("Your answer")} and ${ui("Send answer")}, or ${ui("Keep editing")} to change the design.`],
    [ui("The code can't do part of it"), "Part of a design can't be built as drawn.", `${ui("Keep the rest as design")}, or ${ui("Accept the code's version")}.`],
  ],
)}
${h2("your-work", "Your work")}
<p>Everything you've claimed or sent, with where it stands:</p>
${table(
  ["Status", "Means"],
  [
    [ui("In design"), "You're editing your copy."],
    [ui("Ready"), "Sent. Waiting for the developer."],
    ["Reviewed", "The developer approved it, set it for later, or asked something."],
    ["Being built", "A developer started on it (\"Marco is building it\")."],
    ["In code: 2 of 3", "How many of your changes the code does, at the last sync."],
    ["Done", "The code matches. The copy goes to the Archive."],
  ],
)}
${h2("in-sync", "In sync")}
<p>Components and pages where Live and your designs agree. Nothing to do.</p>
${h2("people", "People")}
<p>Who is in the project, pending invitations and how each invitation email went (${ui("Invitation email sent")}, ${ui("Invitation email on its way")}, ${ui("No invitation email sent")}). ${ui("Send again")} resends one; ${ui("Send invite")} adds someone.</p>
${h2("guide", "Guide")}
<p>The ${ui("Guide")} button at the top opens a checklist of what you can do with CoDesignFlo. ${ui("Show the checklist again")} brings it back after you've hidden it.</p>
${h2("notices", "Notices")}
<p>The panel also shows when Live is updating (${ui("Updating Live from code")}), when your free sends to dev are running out, and when something needs the project's owner.</p>`,
      },
      {
        slug: "proposing-changes",
        title: "Proposing a change",
        summary: "Claim a component or page, change your copy, send it, and take it back if needed.",
        body: () => `
${h2("claim", "Claim")}
${steps([
  `Select a component or page on Live (or find it with ${ui("Search components")}).`,
  `Click ${ui("Claim")}. A copy appears on ${ui("Proposals › Active")} and is selected for you (${ui("You're editing your copy")}).`,
])}
${note("note", "One designer at a time", "A component or page someone else has claimed shows who has it. You can't claim it until they send or unclaim it.")}
${h2("edit", "Edit freely")}
<p>Change the copy any way you like: fills, strokes, text, sizes, spacing, auto layout, effects, new or removed layers. Use your team's styles and variables; changes that match the app's tokens reach the developer as those tokens.</p>
${ul([
  `${ui("Select in your copy")} jumps to the copy; ${ui("Show in Live")} to the original.`,
  `${ui("Undo this change in your copy")} reverts one change from the list.`,
  `${ui("Unclaim")} gives the component back and removes your copy.`,
])}
${h2("send", "Send it")}
${steps([
  `Click ${ui("Ready for dev")}. The plugin lists the changes it found (${ui("What changed and why")}) so you can spot anything changed by mistake.`,
  "Add a note for the developer: the intent, edge cases, what matters most.",
  `Click ${ui("Send to developer")}. Your developer is notified.`,
])}
${h2("take-back", "Take it back")}
<p>${ui("Keep editing")} reopens a sent design. Sending again replaces what the developer got. ${ui("Withdraw")} cancels it.</p>
${h2("clash", "When the code changed the same thing")}
<p>If the code changes the same properties while you work, the row says so. Your design wins unless the developer has a functional reason, which they send you. See ${link("conflicts", "When code and design both change")}.</p>`,
      },
      {
        slug: "new-designs",
        title: "New components and pages",
        summary: "Design something the app doesn't have yet and send it.",
        body: () => `
${steps([
  "Draw the new component or page anywhere in your file, in its own top-level frame (or as a component).",
  `Select it and click ${ui("Send new design")} in the plugin.`,
  "Name it and add a note: what it's for, where it goes in the app, its states.",
  `Send it. It appears in your work as a ${ui("New design")}.`,
])}
${h2("several", "Several at once")}
<p>Select several frames and use ${ui("Send as new designs")}.</p>
${h2("after", "When it's built")}
<p>Once the developer builds it and syncs on the Live branch, it appears in Live, and your frame moves to the Archive.</p>
${note("tip", "Using your components", `New designs built with your Design System components reach the developer as "use this component with these properties". See ${link("design-system", "Your design system")}.`)}`,
      },
      {
        slug: "tracking",
        title: "Following the build",
        summary: "What happens after you send: reviews, questions, progress and closing.",
        body: () => `
${h2("review", "Review")}
<p>Before building, a developer may review your design with their agent and record a decision: approved, set for later, skipped (with a reason), or a question for you.</p>
${h2("questions", "Questions")}
<p>A question appears under ${ui("Needs you")}. Answer on the row with ${ui("Send answer")}. Your answer goes straight to the developer's agent.</p>
${h2("building", "Being built")}
<p>"Marco is building it": a developer started. Only one developer builds a design at a time.</p>
${h2("progress", "Progress")}
<p>Each time the developer syncs, the row updates: "In code: 2 of 3 changes", then "Done in code".</p>
${h2("closing", "Closing")}
<p>When Live, rebuilt from the code, matches your design, the design closes. Your copy moves to ${ui("Proposals › Archive")}.</p>
${h2("notifications", "Notifications")}
<p>You also get an email when something needs you, and the project's Slack channel if an admin connected one. See ${link("notifications", "Notifications")}.</p>`,
      },
      {
        slug: "conflicts",
        title: "When code and design both change",
        summary: "Clashes between your copy and code that moved meanwhile, and how they're settled.",
        body: () => `
<p>While you edit a copy, developers keep shipping. If the code changes <i>the same properties</i> you changed, the proposal shows ${ui("Code changed the same things")}.</p>
${h2("rule", "The rule")}
<p><b>The design wins</b>, unless the developer has a functional reason for the code's version (accessibility, a platform limit, data that doesn't fit). They send that reason to you.</p>
${h2("options", "Your options")}
${ul([
  `${ui("Design wins")}: your values stay; the developer builds them.`,
  `${ui("Code wins")}: you take the code's values into your copy.`,
  "Different properties never clash: both changes are kept.",
])}`,
      },
      {
        slug: "design-system",
        title: "Your design system",
        summary: "Link your own components to the code's, so Live and your designs use them.",
        body: () => `
<p class="dx-lead">If your team has its own components in Figma, link each to the code's. Live is then drawn with yours, and every linked pair shows where design and code differ.</p>
${h2("create", "Create the page")}
<p>In the plugin, ${ui("Create the Design System page")}. It has two sections:</p>
${table(
  ["Section", "Holds"],
  [
    [ui("Library"), "Your components: instances from your team library, or copies. Each is linked to a code component, or design-only (not in code yet)."],
    [ui("From code"), "A copy of each code component you don't have yet, waiting for you to accept it or match it to one of yours."],
  ],
)}
${h2("link", "Link components")}
${steps([
  "The plugin suggests pairs between your components and the code's, and how their properties match (variants, text, booleans).",
  `${ui("Link")} accepts a pair; ${ui("Not this")} rejects it; ${ui("Link this one")} picks another.`,
  `${ui("Properties")} shows and edits how properties map. ${ui("Unlink")} undoes a link.`,
])}
${note("note", "Nothing is linked silently", "The plugin only suggests. You confirm every link.")}
${h2("effects", "What links change")}
${ul([
  "Live's pages are drawn with your components wherever they're linked.",
  `Each linked pair lists where your component differs from what the app draws. ${ui("Use the code's")} takes the code's version; or claim it and send yours as a proposal.`,
  "Designs that use your components reach the developer as \"use this component with these properties\".",
  "Components with no link work as before: Live uses the code's version.",
])}
${h2("screens", "Your existing screens")}
<p>${ui("Use Live in my screens")} swaps the code's components into your own screens where they're linked, so your mockups stay current.</p>`,
      },
      {
        slug: "live-updates",
        title: "How Live updates",
        summary: "When updates arrive, what the plugin does, and how to keep it fast.",
        body: () => `
${h2("when", "When")}
<p>Developers sync on the Live branch (by hand, through their agent, or after every commit). The update waits on the service until the file is open with the plugin.</p>
${h2("apply", "Applying")}
<p>Open the file and the plugin. It applies waiting updates by itself (${ui("Updating Live from code")}), Live first, then branch previews.</p>
${note("warn", "Keep Figma visible", "Figma slows down plugins in a window you can't see. Keep the Figma window visible while an update applies.")}
${h2("what-changes", "What changes")}
${ul([
  "Components and pages whose code changed are rebuilt; the rest stay as they are.",
  "Designs that the code now matches close.",
  "Rows appear under Needs you for new or updated things.",
  "Parts kept as design stay as you drew them.",
])}
${h2("nothing", "Nothing happens?")}
<p>See ${link("troubleshooting", "Troubleshooting", "live-not-updating")}.</p>`,
      },
    ],
  },
  {
    title: "For developers",
    pages: [
      {
        slug: "requirements",
        title: "Requirements",
        summary: "What your app and machine need for CoDesignFlo.",
        body: () => `
${table(
  ["Need", "Details"],
  [
    ["Git repository", "At least one commit. The project is identified by the first commit and the app's folder, so every clone is the same project."],
    ["React + Storybook", "Stories for your components (each becomes a component in Live) and for your pages (title them <code>Pages/…</code>)."],
    ["Node.js", "On your machine. Sync builds Storybook and renders it in a headless browser locally."],
    ["Design tokens (optional)", "A DTCG JSON file. Live binds colours and sizes to your tokens."],
    ["A coding agent (optional)", "Any agent that supports remote MCP servers with sign-in, and can run commands in your project. Or use the CLI."],
  ],
)}
${h2("no-app", "No app yet?")}
<p>Ask your agent to set up CoDesignFlo in an empty folder: it offers to create a React + Vite + Storybook app with a tokens file first.</p>
${h2("monorepos", "Monorepos")}
<p>Each app folder in a repository can be its own project. Run the setup in the app's folder.</p>`,
      },
      {
        slug: "connect",
        title: "Connecting your agent",
        summary: "Add CoDesignFlo's MCP server to Claude Code, Cursor, VS Code, Codex, Gemini CLI or Windsurf.",
        body: (x) => {
          const list = agents(x.mcpUrl);
          return `
<p class="dx-lead">CoDesignFlo is a remote MCP server. Your agent connects to it once, for all your folders, and signs in with your CoDesignFlo account.</p>
${h2("address", "Server address")}
${code(x.mcpUrl, "url")}
${h2("agents", "Your agent")}
<div class="dx-tabs" role="tablist">${list.map((a, i) => `<button type="button" role="tab" class="dx-tab${i ? "" : " on"}" data-tab="${a.id}">${esc(a.name)}</button>`).join("")}</div>
${list
  .map(
    (a, i) => `<div class="dx-tabpanel" data-panel="${a.id}"${i ? " hidden" : ""}>${
      a.install ? `<p><a class="dx-btn" href="${esc(a.install.href)}">${esc(a.install.label)}</a></p>` : ""
    }${a.steps.map((s) => `<p>${esc(s.text)}</p>${s.code ? code(s.code) : ""}`).join("")}</div>`,
  )
  .join("")}
${h2("sign-in", "Signing in")}
<p>The first time the agent uses CoDesignFlo, your browser opens. Continue with GitHub (or the account you use) and click ${ui("Connect")}. The agent then acts as you, in the projects you're in.</p>
${h2("first-prompt", "Then")}
<p>In your app's folder:</p>
${code("Connect this app to CoDesignFlo", "prompt")}
${note("tip", "Without an MCP agent", `Everything also works from a terminal with the CLI. See ${link("cli-reference", "CLI")}.`)}`;
        },
      },
      {
        slug: "setup",
        title: "Setting up a project",
        summary: "What \"connect this app\" does: identity, the config file, the Live branch, invitations.",
        body: () => `
${h2("identity", "How the project is found")}
<p>A project is tied to your repository's <b>first commit</b> and the <b>app's folder</b> in it. Every clone, fork and branch is the same project, whatever its remote, even before anything is pushed. Your agent reads them with:</p>
${code("git rev-list --max-parents=0 HEAD\ngit rev-parse --show-prefix", "bash")}
${h2("paths", "Three ways in")}
${table(
  ["Situation", "What happens"],
  [
    ["You start", "A new project is created for the code. Invite your designer next."],
    ["Your designer started it in Figma and invited you", "The agent lists the projects waiting for their code. Pick one: your code is linked to it for good."],
    ["The project exists already", "It's found by the repository's identity. Nothing to choose."],
  ],
)}
${h2("config", "The config file")}
<p>The agent writes ${c(".codesignflo/config.json")}. Commit it.</p>
${code(`{
  "projectId": "p_e3abff2f9ff1",
  "tokens": "tokens/tokens.json",
  "storybook": {
    "build": "pnpm build-storybook",
    "out": "storybook-static"
  },
  "trackedBranch": "main"
}`, "json")}
${table(
  ["Field", "Meaning"],
  [
    [c("projectId"), "The CoDesignFlo project."],
    [c("tokens"), "Your DTCG tokens file, if any."],
    [c("storybook.build"), "The command that builds Storybook."],
    [c("storybook.out"), "Where the build goes."],
    [c("trackedBranch"), "The Live branch."],
  ],
)}
${h2("live-branch", "The Live branch")}
<p>Commits on this branch update Live. Change it any time: ask your agent, or ${c("codesignflo live-branch <name>")} (developers and admins).</p>
${h2("build-mode", "Where designs are built")}
${table(
  ["Mode", "Meaning"],
  [
    [c("storybook-first"), "Designs are built in Storybook only (components and page stories), and wired into the app after they're reviewed in Figma."],
    [c("storybook-and-app"), "Built in Storybook and the app together."],
  ],
)}
<p>Set it with the ${c("set_build_mode")} tool.</p>
${h2("invite", "Inviting the designer")}
<p>The agent asks for your designer's email and invites them. They get an email with how to open the plugin. See ${link("people", "Inviting people and roles")}.</p>`,
      },
      {
        slug: "syncing",
        title: "Syncing",
        summary: "What sync does, when it updates Live, and its options.",
        body: () => `
${h2("what", "What sync does")}
${steps([
  "Builds your Storybook.",
  "Renders every component and page story in a headless browser, on your machine.",
  "Compiles what the browser drew into Figma layers, bound to your tokens.",
  "Checks every open design against the result.",
  "On the Live branch with everything committed: uploads a Live update, and if the Figma file is open, waits for the plugin to apply it and reports how it went.",
])}
${h2("run", "Running it")}
<p>Ask your agent to "sync". It calls the ${c("sync")} tool, which returns a command with a one-time sign-in ticket, and runs it in your app's folder. From a terminal:</p>
${code("npx @codesignflo/cli sync", "bash")}
${note("note", "It takes a while", "A full sync can take a few minutes on a large Storybook. Agents should give it a generous timeout (up to 5 minutes).")}
${h2("where", "Where it updates Live")}
${table(
  ["You're on", "Sync does"],
  [
    ["The Live branch, everything committed", "Uploads a Live update, checks designs."],
    ["The Live branch, not pulled (behind Live or origin)", "Checks designs only, and says to pull first."],
    ["The Live branch, uncommitted changes", "Checks designs only."],
    ["A connected branch, everything committed", `Updates its lane beside Live, checks designs (${link("previews", "Branch lanes")}).`],
    ["Another branch", `Checks designs only. ${c("--preview")} shows the branch in Figma once.`],
  ],
)}
${h2("options", "Options")}
${table(
  ["Option", "Effect"],
  [
    [c("--only a,b"), "Update just these components or pages in Live (when building designs one at a time)."],
    [c("--preview"), "On a feature branch: show it in Figma beside Live."],
  ],
)}
${h2("next", "Next")}
<p>${link("sync-results", "Reading sync results")} explains everything sync reports.</p>`,
      },
      {
        slug: "sync-results",
        title: "Reading sync results",
        summary: "The three kinds of findings, and which ones are yours to fix.",
        body: () => `
<p class="dx-lead">Sync reports three kinds of differences. They're handled very differently, so it matters which is which.</p>
${h2("progress", "\"N of M of the designer's changes in the code\"")}
<p><b>Yours to finish.</b> A design in progress: keep implementing and sync again until it says "looks done". If something can't be done cleanly, ask the designer (${c("ask_designer")}).</p>
${h2("app-vs-design", "\"Where the app differs from the designer's design\"")}
<p><b>Code to change</b>, usually. These pages are built on the designer's own design, so the design is the reference. Ask the user when a difference looks intended.</p>
${h2("live-vs-app", "\"Where Live differs from the app\"")}
<p><b>Not your code.</b> Live couldn't draw something exactly as the browser did: a font Figma lacks, text wrapping differently. The app is right. Don't change code to chase these; each comes with a suggested action.</p>
${note("warn", "Exception", "A note that says \"code to change\" (for example design framing like a browser window bar built as app UI) is for you.")}
${h2("library", "\"Where the designer's Library component differs\"")}
<p>The designer's design system against the code. Theirs to decide.</p>
${h2("closed", "Closed")}
<p>Designs whose code matches. The designer is told.</p>
${h2("all", "Everything")}
<p>${c("status")} with ${c("all=true")} (or ${c("codesignflo status --all")}) lists every place Live differs from the app.</p>`,
      },
      {
        slug: "reviewing",
        title: "Reviewing designs",
        summary: "Go through what the designer sent, one design at a time, before building.",
        body: () => `
<p>Reviewing is optional, and recommended when several designs arrive at once. Ask your agent:</p>
${code("Review the designs with me", "prompt")}
${h2("queue", "The queue")}
<p>${c("review_queue")} lists what the designer sent in the order to build it: components before the pages that use them, with each design's decision so far and a link to it in Figma.</p>
${h2("brief", "The brief")}
<p>${c("get_proposal")} with ${c("review=true")} gives a review brief for one design: what changed, what it touches in the code, open questions. No code changes.</p>
${h2("decide", "Decisions")}
${table(
  ["Decision", "Meaning"],
  [
    [c("approved"), "With a plan: how it will be built."],
    [c("questions"), "A question the designer answers in the plugin."],
    [c("later"), "Not now."],
    [c("skipped"), "Won't be built, with why."],
  ],
)}
<p>${c("record_review")} records it; the designer sees it on the row.</p>`,
      },
      {
        slug: "building",
        title: "Building designs",
        summary: "From a design to committed code, one design at a time.",
        body: () => `
<p>Ask your agent:</p>
${code("Build the approved designs", "prompt")}
${h2("loop", "For each design")}
${steps([
  `${c("start_building")}: the designer and the other developers see you're on it.`,
  `${c("get_proposal")}: the changes as instructions, in your components and tokens.`,
  "Implement them any way you like. Check in Storybook.",
  "Commit.",
  `${c("sync")} with ${c("only")} set to that design. Repeat until it says "looks done".`,
])}
${h2("stuck", "When it can't be done cleanly")}
<p>${c("ask_designer")} sends the design back with your question. Don't guess.</p>
${h2("clash", "Clashes")}
<p>When the design and code that moved meanwhile changed the same things: ${c("resolve")} with ${c("take=design")} (the default rule) or ${c("take=code")} with a reason for the designer.</p>
${h2("waiting", "Waiting for the designer")}
<p>${c("wait_for_designer")} waits until something happens (a new design, an answer, a close, a Live update) and says what. Call it again to keep waiting.</p>`,
      },
      {
        slug: "stories",
        title: "Writing stories for Live",
        summary: "How stories become Live's components and pages, and the parameters CoDesignFlo reads.",
        body: () => `
${h2("mapping", "From stories to Live")}
${table(
  ["Storybook", "Live"],
  [
    ["A component's stories", "One component; each story a variant."],
    ["Stories titled <code>Pages/…</code>", "A page each."],
    ["Components without stories", "Not in Live."],
  ],
)}
${h2("rendering", "How they're rendered")}
${ul([
  "At the story's Storybook viewport, or 1200×900.",
  "With the clock fixed to 1 January 2026, so dates don't change Live on every sync.",
])}
${h2("parameters", "Parameters")}
${code(`export const Inbox = {
  parameters: {
    codesignflo: {
      size: { width: 1440, height: 900 }, // the frame's size in Live
      fullHeight: true,                   // an app shell 100vh tall whose panel scrolls
      date: "2026-05-01",                 // fixtures with real dates
    },
  },
};`, "tsx")}
${note("warn", "Component stories aren't fullscreen", `${c('layout: "fullscreen"')} makes a story a page. Use ${c('parameters: { layout: "padded" }')} for components.`)}
${h2("missing", "Missing stories")}
<p>Ask "which components have no story?" (${c("missing_stories")}, or ${c("codesignflo stories")}), or "write the missing stories" (the ${c("cover_components")} prompt). Building blocks your pages use most come first.</p>`,
      },
      {
        slug: "tokens",
        title: "Design tokens",
        summary: "How your tokens file connects Live to the designer's variables.",
        body: () => `
<p>With a tokens file in DTCG JSON format, Live binds colours, sizes and spacing to your tokens instead of raw values, and designs come back to you in tokens.</p>
${code(`{
  "color": {
    "primary": { "$type": "color", "$value": "#2d6cdf" }
  },
  "space": {
    "md": { "$type": "dimension", "$value": "16px" }
  }
}`, "json")}
${ul([
  `Set its path in ${c(".codesignflo/config.json")} (${c("tokens")}).`,
  "A design that changes a colour to one of your tokens reaches you as that token.",
])}`,
      },
      {
        slug: "naming",
        title: "Naming elements",
        summary: "data-cdf names that let Live follow the design's layers.",
        body: () => `
<p>Live pairs the app's elements with the designer's layers. Giving elements the same names makes that pairing exact.</p>
${code(`<header data-cdf="Top bar">
  <h1 data-cdf="Title">Inbox</h1>
</header>`, "tsx")}
${ul([
  `${c("pair_design")} lists a design's layer names and nesting, for a page built on the designer's design.`,
  "Names only: they don't change how the app looks or behaves.",
  `${c("codesignflo name")} names unnamed elements with Claude Code.`,
])}`,
      },
      {
        slug: "previews",
        title: "Branch lanes",
        summary: "Keep a feature branch beside Live in Figma, with the designs it builds marked.",
        body: () => `
${steps([
  `On your feature branch, ask your agent to "connect this branch to CoDesignFlo" (${c("connect_branch")}), or run ${c("codesignflo branch connect")}.`,
  "Commit and sync. Every sync on the branch from then on (by hand, your agent's, the git hook's) updates its lane.",
  `The designer's plugin builds a ${ui("Branch: name")} section on the Live page, beside Live, with only what differs from Live: changed components, and pages that changed or use one.`,
])}
${ul([
  `Designs the branch builds are marked in the lane (${ui("Ana's design · 2 of 3 changes in the code")}), and beside the designer's copy in her lane (${ui("Being built on feat/checkout")}), each linking to the other.`,
  "Live, its history and the designs stay as they are: a lane records nothing.",
  `When the branch is merged and Live updates, the lane goes by itself. ${c("codesignflo branch disconnect")} takes it out before.`,
  `A sync on a lane that isn't pulled (behind ${c("origin")}, or behind what the lane shows) only checks the designs and says to pull first.`,
  `Just a look, no lane: ${c("sync --preview")} shows a branch once; it goes when the branch is merged.`,
  `${c("codesignflo branch")} lists the connected branches; ${c("status")} too.`,
])}`,
      },
      {
        slug: "auto-update",
        title: "Live on every commit",
        summary: "A git hook that syncs after each commit to the Live branch.",
        body: () => `
<p>Ask your agent to "update Live on every commit" (${c("auto_update")}), or:</p>
${code("npx @codesignflo/cli hook install", "bash")}
${ul([
  "Installs a git hook on your machine, outside the repository, with its own sign-in.",
  "After each commit to the Live branch, it syncs in the background.",
  `Turn it off with ${c("hook remove")}.`,
])}`,
      },
      {
        slug: "team",
        title: "Several developers",
        summary: "Who updates Live, and how developers avoid building the same design.",
        body: () => `
${ul([
  "Each developer signs in with their own account and connects their own agent.",
  "Any developer's commit on the Live branch updates Live when they sync.",
  `Live never goes back: a sync on a Live branch that's behind Live or behind ${c("origin")} (not pulled yet), or split from it, only checks the designs and says to pull first. Committed but not pushed yet is fine.`,
  `${c("start_building")} marks a design as yours. Others see it in ${c("review_queue")}, ${c("status")} and ${c("get_proposal")}.`,
  `Taking it over needs ${c("take_over")} (the agent asks you first). ${c("stop")} hands it back. It clears when the design closes.`,
])}`,
      },
      {
        slug: "mcp-reference",
        title: "MCP tools",
        summary: "Every tool and prompt the CoDesignFlo MCP server offers.",
        body: () => `
${h2("tools", "Tools")}
${table(
  ["Tool", "What it does"],
  [
    [c("init"), "Finds this app's project by its repository identity, links a project a designer started, or creates one. Returns the config file to write."],
    [c("status"), "What the designer sent, how the code stands with each design, and how Live stands (all=true: every difference)."],
    [c("sync"), "The command that renders Storybook, checks designs and updates Live."],
    [c("review_queue"), "Designs in the order to review and build."],
    [c("get_proposal"), "A design as implementation instructions (review=true: a review brief)."],
    [c("record_review"), "Approved, questions, later or skipped."],
    [c("start_building"), "Marks you as building a design (take_over, stop)."],
    [c("ask_designer"), "Sends a design back with a question."],
    [c("resolve"), "Settles a clash: take=design or take=code with a reason."],
    [c("wait_for_designer"), "Waits for the next thing to happen."],
    [c("pair_design"), "A design's layer outline, to name elements (data-cdf)."],
    [c("missing_stories"), "Components without a story."],
    [c("invite"), "Invites someone by email."],
    [c("resend_invitation"), "Sends an invitation email again."],
    [c("people"), "Members and pending invitations."],
    [c("set_live_branch"), "Which branch updates Live."],
    [c("connect_branch"), "Give a branch a lane beside Live (disconnect, list)."],
    [c("set_build_mode"), "storybook-first or storybook-and-app."],
    [c("auto_update"), "Live on every commit (git hook)."],
    [c("report_issue"), "Reports a problem with CoDesignFlo itself (only when you agree)."],
  ],
)}
${h2("prompts", "Prompts")}
${table(
  ["Prompt", "What it does"],
  [
    [c("set_up"), "Connect this app, step by step."],
    [c("review_designs"), "Review the designs with you, one at a time."],
    [c("implement_design"), "Build what was approved, one at a time."],
    [c("cover_components"), "Write stories for components that have none."],
  ],
)}`,
      },
      {
        slug: "cli-reference",
        title: "CLI",
        summary: "The command-line tool: the same as the agent, from a terminal.",
        body: () => `
<p>No installation needed:</p>
${code("npx @codesignflo/cli <command>", "bash")}
${table(
  ["Command", "What it does"],
  [
    [c("login"), "Signs in (opens the browser). --no-browser prints a link."],
    [c("whoami"), "Who you're signed in as."],
    [c("logout"), "Revokes this machine's sign-in (--everywhere: all sessions)."],
    [c("init --cloud"), "Connects this app (--project <id> | --new)."],
    [c("status"), "What waits on you, and each component's state (--all)."],
    [c("sync"), "Renders, checks and updates Live (--only a,b; --preview)."],
    [c("proposal <component>"), "A design as instructions (--json)."],
    [c("ask <component> \"<question>\""), "Sends a design back with a question."],
    [c("resolve <component> --design | --code \"<why>\""), "Settles a clash."],
    [c("stories"), "Components without a story (--json)."],
    [c("verify"), "Compares Live with the code, variant by variant."],
    [c("name"), "Names unnamed elements (data-cdf) with Claude Code."],
    [c("invite <email>"), "--designer (default), --developer or --admin; --resend."],
    [c("people"), "Who is in the project."],
    [c("live-branch [<name>]"), "Shows or sets the Live branch."],
    [c("branch [connect | disconnect] [<name>]"), "Branches with a lane beside Live (without arguments: the connected ones)."],
    [c("hook install | remove"), "Live on every commit."],
    [c("mcp"), "Runs the MCP server locally (stdio)."],
    [c("version"), "Prints the version."],
  ],
)}`,
      },
    ],
  },
  {
    title: "Teams and account",
    pages: [
      {
        slug: "people",
        title: "Inviting people and roles",
        summary: "Invitations, roles, and who can do what.",
        body: () => `
${h2("invite", "Inviting")}
<p>From the plugin (${ui("People")}), the web app (a project's People), the CLI (${c("codesignflo invite")}) or an agent (${c("invite")}). Invitations are by email: the person joins when they sign in with that address.</p>
${ul([
  "Designers get the steps to open the Figma plugin.",
  "Developers get the link to connect their coding agent.",
  "Each invitation shows how its email went. Send again at most once every 2 minutes.",
])}
${h2("roles", "Roles")}
${table(
  ["", "Designer", "Developer", "Admin"],
  [
    ["Claim and send designs", "✓", "", "✓"],
    ["Connect code, sync, build", "", "✓", "✓"],
    ["Invite designers and developers", "✓", "✓", "✓"],
    ["Invite admins", "", "", "✓"],
    ["Project settings, Slack", "", "", "✓"],
  ],
)}
${note("note", "One designer per component", "Several designers can work in a project; each component or page is claimed by one at a time.")}`,
      },
      {
        slug: "notifications",
        title: "Notifications",
        summary: "Emails and Slack: what's sent, and how to change it.",
        body: () => `
${h2("email", "Email")}
<p>You get an email when something needs you: a design ready for dev, a question, an answer. Routine news (building started, done in code, Live updated) goes only to the project's Slack, if it has one. Turn your own emails off in the web app (project Settings).</p>
${h2("slack", "Slack")}
<p>A project's admins can add a Slack incoming webhook in the web app (Settings › Notifications). The same events go to that channel.</p>`,
      },
      {
        slug: "billing",
        title: "Pricing and billing",
        summary: "What's paid, by whom, the free sends, and managing a subscription.",
        body: () => `
${table(
  ["", "Price"],
  [
    ["Developers", "Free"],
    ["Designers", `€${SEAT_EUR} per designer per month, VAT included, after ${FREE_SENDS} free sends to dev`],
  ],
)}
${
  launchOn()
    ? note("tip", "Launch price", `Subscribe by ${LAUNCH.until} and pay €${LAUNCH.eur} per designer a month, VAT included, for your first ${LAUNCH.months} months, then €${SEAT_EUR}. It's applied at checkout by itself.`)
    : ""
}
${h2("vat", "VAT")}
<p>${VAT_NOTE} Checkout asks for your billing address, and businesses can enter their VAT ID; invoices show the VAT included.</p>
${h2("who", "Who pays")}
<p>A <b>designer seat</b> belongs to a person (their email), not to a project. With a seat, a designer works in every project: ones they started and ones they're invited to, whoever owns them. Developers never need one.</p>
<p>A seat can be paid by the designer, or by someone else. A team lead or a client adds their designers' emails in ${ui("Billing")} and pays for all of them in one subscription. Someone who hasn't signed up yet gets the seat as soon as they do. An email can have only one payer.</p>
${h2("free", "Free sends")}
<p>Every designer gets ${FREE_SENDS} sends to dev for free, for good, across all their projects. Each time a design goes to the developers (${ui("Ready for dev")}, or a new design) uses one, re-sends included. No card needed, and no time limit.</p>
${h2("without", "Without a seat")}
<p>After the free sends, a designer without a seat can still open the plugin, browse Live, claim and edit. What waits is <b>sending designs to developers</b> (${ui("Ready for dev")}, new designs): the plugin keeps them and sends them by itself once there's a seat. Live keeps updating for everyone, and developers aren't affected.</p>
${h2("subscribing", "Subscribing")}
${steps([
  `Open the web app and go to ${ui("Billing")}.`,
  `${ui("Pay for my seat")} adds your email; add other designers' emails under ${ui("Seats you pay for")}.`,
  `${ui("Subscribe")}: Stripe Checkout opens for those seats.`,
  `Later, add or remove seats on the same page; the bill follows, prorated. ${ui("Manage billing")} (Stripe's portal): payment method, invoices, cancel.`,
])}`,
      },
      {
        slug: "privacy",
        title: "Data and privacy",
        summary: "What leaves your machine, what's stored, and for how long.",
        body: () => `
${h2("never", "Never uploaded")}
<p>Your source code.</p>
${h2("uploaded", "Uploaded by sync")}
${ul([
  "The layout, text and styles of each story as the browser drew it.",
  "Which files and stories make each component.",
  "The app's images, and a screenshot of each page.",
])}
${h2("telemetry", "Diagnostics")}
<p>What failed and how long steps took, in structure and numbers only. A project's content (full logs, reports) is shared only if the project turns it on in its settings; kept 90 days, seen only by CoDesignFlo's team.</p>
<p>Full details: <a href="#/privacy">Privacy policy</a>.</p>`,
      },
      {
        slug: "troubleshooting",
        title: "Troubleshooting",
        summary: "Common problems and how to fix them.",
        body: () => `
${h2("live-not-updating", "Live doesn't update")}
${ul([
  "Was the sync on the Live branch, with everything committed? Otherwise it only checks designs.",
  "Is the Figma file open with the plugin? Updates wait until it is.",
  "Is the Figma window visible? Figma slows down hidden plugins.",
])}
${h2("no-component", "A component isn't in Live")}
<p>It needs a story. Run ${c("codesignflo stories")}. Component stories must not use ${c('layout: "fullscreen"')}.</p>
${h2("looks-different", "Live looks different from the app")}
<p>Check sync's "Where Live differs from the app" findings: a missing font in Figma, text wrapping. Install the font in Figma, or set the story's ${c("codesignflo")} parameters (size, fullHeight, date).</p>
${h2("dates", "Live changes on every sync")}
<p>Dates or random data in fixtures. Live fixes the clock to 1 January 2026; use ${c("codesignflo: { date }")} for fixtures with real dates.</p>
${h2("read-only", "\"Designs you send wait until you have a seat\"")}
<p>Your ${FREE_SENDS} free sends to dev are used. Pay for your seat in the web app (${ui("Billing")}), or ask someone to pay for it; nothing is lost meanwhile, and the designs waiting in the plugin go out by themselves once you have a seat.</p>
${h2("invite", "An invitation didn't arrive")}
<p>Check People for the email's status. Ask them to check spam, or ${ui("Send again")}. They can also just sign in with that email: the invitation applies.</p>
${h2("agent", "My agent can't connect")}
<p>Check the server address (${link("connect", "Connecting your agent")}), then sign in again from your agent's MCP settings.</p>
${h2("report", "Something else")}
<p>Ask your agent to report it (${c("report_issue")}), or <a href="mailto:contact@orkestralai.com">email us</a>.</p>`,
      },
      {
        slug: "faq",
        title: "FAQ",
        summary: "Short answers to common questions.",
        body: () => `
${h2("figma-plan", "Which Figma plan do I need?")}<p>Any. It fits the free plan's three pages.</p>
${h2("dev-figma", "Do developers need Figma?")}<p>No. Developers use their coding agent or the CLI.</p>
${h2("frameworks", "Which frameworks?")}<p>React with Storybook today.</p>
${h2("code-upload", "Is our code uploaded?")}<p>No. See ${link("privacy", "Data and privacy")}.</p>
${h2("online", "Do designer and developer need to be online together?")}<p>No. Everything waits on the service until the other side picks it up.</p>
${h2("existing-file", "Can I use an existing Figma file?")}<p>Yes. CoDesignFlo adds its pages and leaves yours alone.</p>
${h2("several-files", "Several Figma files for one app?")}<p>A project has one file today.</p>`,
      },
    ],
  },
];

const PAGES = GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.title })));
export const DOC_SLUGS = PAGES.map((p) => p.slug);
export const docTitle = (slug: string) => PAGES.find((p) => p.slug === slug)?.title ?? "Docs";

/** Headings of a rendered page body, for "On this page" and search. */
const headings = (body: string) => [...body.matchAll(/<h2 id="([^"]+)">.*?<\/a>(.*?)<\/h2>/g)].map((m) => [m[1]!, m[2]!.replace(/<[^>]+>/g, "")] as const);

/** Search entries: every page and every section. */
export function docIndex(ctx: DocCtx) {
  return PAGES.flatMap((p) => [
    { slug: p.slug, sec: "", title: p.title, where: p.group, text: p.summary },
    ...headings(p.body(ctx)).map(([id, t]) => ({ slug: p.slug, sec: id, title: t, where: p.title, text: "" })),
  ]);
}

export function docHtml(slug: string, ctx: DocCtx): string {
  const i = Math.max(0, PAGES.findIndex((p) => p.slug === slug));
  const page = PAGES[i]!;
  const body = page.body(ctx);
  const toc = headings(body);
  const prev = PAGES[i - 1];
  const next = PAGES[i + 1];
  return `<div class="dx">
  <header class="dx-top">
    <button type="button" class="dx-menu" aria-label="Menu" data-dx-menu>☰</button>
    <a href="#/" class="dx-brand">CoDesignFlo</a><a href="#/docs/overview" class="dx-brand-docs">Docs</a>
    <div class="dx-search"><input type="search" placeholder="Search the docs" aria-label="Search the docs" data-dx-search><div class="dx-results" hidden data-dx-results></div></div>
    <span class="dx-grow"></span>
    <a href="#/" class="dx-toplink">Home</a>
    <a href="#/signin" class="dx-btn">Open the app</a>
  </header>
  <div class="dx-body">
    <nav class="dx-side" data-dx-side>${GROUPS.map(
      (g) =>
        `<div class="dx-group"><p>${g.title}</p>${g.pages.map((p) => `<a href="#/docs/${p.slug}"${p.slug === page.slug ? ' class="on" aria-current="page"' : ""}>${p.title}</a>`).join("")}</div>`,
    ).join("")}</nav>
    <main class="dx-main">
      <article class="dx-content">
        <p class="dx-crumbs"><a href="#/docs/overview">Docs</a> <span>›</span> ${page.group}</p>
        <h1>${page.title}</h1>
        ${body}
        <nav class="dx-pager">${prev ? `<a href="#/docs/${prev.slug}" class="dx-prev"><span>Previous</span><b>${prev.title}</b></a>` : "<span></span>"}${
          next ? `<a href="#/docs/${next.slug}" class="dx-next"><span>Next</span><b>${next.title}</b></a>` : ""
        }</nav>
        <footer class="dx-foot"><span>© CoDesignFlo</span><a href="#/privacy">Privacy</a><a href="#/terms">Terms</a><a href="mailto:contact@orkestralai.com">Contact</a></footer>
      </article>
      ${toc.length > 1 ? `<aside class="dx-toc"><p>On this page</p>${toc.map(([id, t]) => `<a href="#" data-doc-sec="${id}">${t}</a>`).join("")}</aside>` : ""}
    </main>
  </div>
</div>`;
}
