// The landing page: what CoDesignFlo is and how to start, for someone who isn't signed in. Sign-in links from
// the plugin, the CLI and coding agents (device codes, agent approval) skip it and go straight to signing in.
// Its look follows OrkestralAI's site: heavy uppercase titles with one phrase on blue, square black buttons and
// outlined cards, light bands with one dark one, and a dark product preview.

import { FREE_SENDS, LAUNCH, launchOn, SEAT_EUR, VAT_NOTE } from "./pricing.ts";
import { footerHtml } from "./legal.ts";
import { logoSvg } from "./logo.ts";

/**
 * The open-source repository, once it's public: the page links to it (and to its self-hosting guide). Empty until
 * then: the page describes self-hosting without links.
 */
const REPO_URL = "https://github.com/orkestralai/codesignflo";
const repoLink = (path: string, label: string) =>
  REPO_URL ? `<a href="${REPO_URL}${path}" target="_blank" rel="noopener">${label}</a>` : label;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export type LandingConfig = {
  /** The hosted MCP's address (coding agents connect to it). */
  mcpUrl: string;
  /** Where designers get the Figma plugin (PLUGIN_INSTALL_URL), if set. */
  pluginUrl?: string;
  /** The plugin's Figma Community page (FIGMA_COMMUNITY_URL), once it's published there: Get started links to it. */
  communityUrl?: string;
  /** The first thing a developer asks their agent. */
  firstPrompt: string;
  /** Opened from a designer's referral link (its code is kept in the browser). */
  referred?: boolean;
  /** The sign-in methods the service offers (the web app's; absent: Figma and GitHub). */
  signIn?: ("figma" | "google" | "github" | "email")[];
};

const LOOP = [
  {
    title: "Code",
    body: "Your app's Storybook: its components and page stories, as your developers build them.",
  },
  {
    title: "Live",
    body: "A page in your Figma file that mirrors the app: real components with their variants, every page as the browser draws it, and a screenshot of the app beside each one. It updates when the code changes.",
  },
  {
    title: "Proposals",
    body: "The designer claims what the developers built, a new component or a whole page, and fixes the look on a copy of it in Figma. Live stays the truth of the code until the fix lands.",
  },
  {
    title: "Back to code",
    body: "The developer's coding agent gets the proposal as precise instructions, implements it, and syncs. When the code matches, the proposal closes and Live shows it.",
  },
];

/** The demo video: the developer ships, the designer fixes the look, the code follows. Loaded only when played. */
const PREVIEW = `<div class="lp-product">
  <video controls playsinline preload="none" poster="/demo-poster.jpg" aria-label="CoDesignFlo demo: a developer ships a badge, the designer fixes its colour in Figma, and the code follows">
    <source src="/demo.mp4" type="video/mp4">
  </video>
</div>`;

export function landingHtml(c: LandingConfig): string {
  const loop = LOOP.map(
    (s, i) => `<li class="lp-step"><span class="lp-n">0${i + 1}</span><h3>${s.title}</h3><p>${s.body}</p></li>`,
  ).join("");
  // Figma Community once the plugin is published there; until then the download (codesignflo.com/plugin.zip).
  const plugin = c.communityUrl
    ? `<span class="lp-dl"><a class="lp-button lp-small" href="${esc(c.communityUrl)}" target="_blank" rel="noopener">Get the Figma plugin</a></span>`
    : c.pluginUrl
      ? `<span class="lp-dl"><a class="lp-button lp-small" href="${esc(c.pluginUrl)}" download>Download the Figma plugin</a></span><span class="lp-dl-how">Unzip it somewhere it can stay, then in Figma: Plugins › Development › Import plugin from manifest, and pick its manifest.json.</span>`
      : `<span class="lp-muted">Find it in Figma Community.</span>`;
  const methods = c.signIn ?? ["figma", "github"];
  // Everyone signs in the way they like (any of the methods, whatever their role): the sign-in page offers them all.
  const start = `<a class="lp-button lp-primary" href="#/signin">Start free</a>`;
  const names = methods.map((m) => ({ figma: "Figma", google: "Google", github: "GitHub", email: "a link by email" })[m]);
  const signInWith = names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return `<div class="lp">
  <header class="lp-top">
    <a href="#/" class="lp-brand">${logoSvg(26)}CoDesignFlo</a>
    <span class="grow"></span>
    <a href="#how" data-scroll="how" class="lp-nav">How it works</a>
    <a href="#start" data-scroll="start" class="lp-nav">Get started</a>
    <a href="#pricing" data-scroll="pricing" class="lp-nav">Pricing</a>
    <a href="#selfhost" data-scroll="selfhost" class="lp-nav lp-nav-wide">Self-host</a>
    ${REPO_URL ? `<a href="${REPO_URL}" target="_blank" rel="noopener" class="lp-nav lp-nav-wide">GitHub</a>` : ""}
    <a href="#/docs/designers" class="lp-nav">Docs</a>
    <a href="#/signin" class="lp-button lp-small">Sign in</a>
  </header>

  <section class="lp-hero lp-white">
    <div class="lp-container">
      <p class="lp-eyebrow lp-boxed">Design and code, in one loop</p>
      <h1 class="lp-title"><span class="lp-line">Your app in Figma.</span> <span class="lp-line lp-hl-text">Your designs in code.</span></h1>
      <p class="lp-lead">Your developers ship faster than you design? Let them. What they build lands in Figma, you fix the look, and their coding agent builds your fix.</p>
      <div class="lp-cta">
        <a class="lp-button lp-big" href="#start" data-scroll="start">Try it free</a>
        <a class="lp-button lp-big lp-outline" href="#selfhost" data-scroll="selfhost">Run it yourself</a>
      </div>
      <p class="lp-free">${FREE_SENDS} designs on us <span>·</span> developers always free <span>·</span> no card needed</p>
      <p class="lp-free">Open source <span>·</span> hosted by us, or free on your own server</p>
      ${c.referred ? `<p class="lp-note lp-ref">Invited by a designer: your second month is free.</p>` : ""}
      <div class="lp-chips"><span class="lp-muted">Works with</span><span class="lp-chip">Figma desktop · free plan too</span><span class="lp-chip">Claude Code · Cursor · VS Code</span></div>
      ${PREVIEW}
    </div>
  </section>

  <section id="about" class="lp-section lp-white">
    <div class="lp-container">
      <div class="lp-head">
        <p class="lp-eyebrow">About</p>
        <h2 class="lp-title-sm">What CoDesignFlo <span class="lp-hl-text">is.</span></h2>
        <p class="lp-lead">A collaboration tool for software teams. What the developers build is drawn in Figma from the code; what the designers change goes back to the code, as instructions their coding agent builds.</p>
      </div>
      <div class="lp-grid lp-three lp-about">
        <div class="lp-card lp-lift"><p class="lp-eyebrow lp-blue-text">Who it's for</p><h3>Teams that code with AI and design in Figma</h3><p>Product teams, agencies and freelancers.</p></div>
        <div class="lp-card lp-lift"><p class="lp-eyebrow lp-blue-text">Works with</p><h3>Storybook, Figma and your agent</h3><p>Figma desktop (free plan too), and Claude Code, Cursor, VS Code or any agent that speaks MCP.</p></div>
        <div class="lp-card lp-lift"><p class="lp-eyebrow lp-blue-text">Stays yours</p><h3>Your code never leaves your machine</h3><p>The app is drawn on your computer; only what Figma needs is uploaded.</p></div>
      </div>
    </div>
  </section>

  <section id="how" class="lp-section lp-dark">
    <div class="lp-container">
      <div class="lp-head">
        <p class="lp-eyebrow lp-blue-text">How it works</p>
        <h2 class="lp-title-sm">Four places. <span class="lp-hl-text">One loop.</span></h2>
        <p class="lp-lead lp-on-dark">Nobody exports, uploads or redraws anything: the code draws Live, the designer changes a copy, the agent brings it back.</p>
      </div>
      <ol class="lp-loop">${loop}</ol>
    </div>
  </section>

  <section id="start" class="lp-section lp-paper">
    <div class="lp-container">
      <div class="lp-head">
        <p class="lp-eyebrow">Get started</p>
        <h2 class="lp-title-sm">Start from <span class="lp-hl-text">either side.</span></h2>
        <p class="lp-lead">Free to start, whichever side you're on. The other joins through an email invitation.</p>
      </div>
      <div class="lp-grid lp-two">
        <div class="lp-card">
          <p class="lp-eyebrow lp-blue-text">For designers</p>
          <h3>Bring your file</h3>
          <div class="lp-card-cta">${start}<span class="lp-muted">${FREE_SENDS} sends to dev free, no card</span></div>
          <ol>
            <li>Install the CoDesignFlo plugin in the Figma desktop app.${plugin}</li>
            <li>Open your team's file, run the plugin, sign in and choose <i>Start a project for this file</i>.</li>
            <li>Invite your developer from <i>People</i>. Live appears after their first sync.</li>
            <li>Keep the file open while Live updates: the plugin applies each update and lists what changed under <i>Needs you</i>.</li>
          </ol>
          <p class="lp-note">Then: browse Live, claim what you want to change, edit your copy in Proposals and send it to dev. <a href="#/docs/designers">Read the designers' guide</a>.</p>
        </div>
        <div class="lp-card">
          <p class="lp-eyebrow lp-blue-text">For developers</p>
          <h3>Bring your agent</h3>
          <div class="lp-card-cta">${start}<span class="lp-muted">Free for developers, always</span></div>
          <ol>
            <li>Connect your coding agent to CoDesignFlo. With Claude Code:
              <pre>claude mcp add --transport http --scope user \\
  codesignflo ${esc(c.mcpUrl)}</pre>
              Cursor, VS Code and others: <a href="#/connect">one step each</a>.</li>
            <li>In your app's folder, ask your agent: <b>"${esc(c.firstPrompt)}"</b>. It links the repo, picks the branch that updates Live, and invites your designer.</li>
            <li>Sync after UI changes, or let Live update on every commit to that branch.</li>
          </ol>
          <p class="lp-note">Your agent asks CoDesignFlo what the designer sent, gets each design as instructions, and syncs until it says "looks done". <a href="#/docs/developers">Read the developers' guide</a>.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="lp-section lp-white">
    <div class="lp-container">
      <div class="lp-head">
        <p class="lp-eyebrow">Day to day</p>
        <h2 class="lp-title-sm">No more <span class="lp-hl-text">handoff.</span></h2>
      </div>
      <div class="lp-grid lp-three">
        <div class="lp-card lp-lift"><p class="lp-eyebrow lp-blue-text">Code → Figma</p><h3>Live follows the code</h3><p>Commit on the Live branch and Live updates in Figma: new components appear, changed pages are redrawn, and each page carries a screenshot of the app as the browser draws it, to compare.</p></div>
        <div class="lp-card lp-lift"><p class="lp-eyebrow lp-blue-text">Figma → code</p><h3>Designs go to the code</h3><p>The designer sends a proposal; the developer reviews it with their agent, one design at a time, and builds it. Questions go back to the designer from inside the agent.</p></div>
        <div class="lp-card lp-lift"><p class="lp-eyebrow lp-blue-text">Both ways</p><h3>Nothing gets lost</h3><p>Hand-made tweaks in Live can be kept as design. Clashes between a proposal and code that moved meanwhile are flagged, with the designer's version winning by default.</p></div>
        <div class="lp-card lp-lift"><p class="lp-eyebrow lp-blue-text">Teams</p><h3>Everyone knows who's on what</h3><p>Designers and developers each sign in with their own account. One designer works on a component at a time, developers say what they're building, and everyone hears about it by email or Slack.</p></div>
        <div class="lp-card lp-lift"><p class="lp-eyebrow lp-blue-text">Before merging</p><h3>Branch previews</h3><p>Show a feature branch in Figma before it's merged: only what differs from Live, in its own section beside it. It goes away once the branch is merged.</p></div>
        <div class="lp-card lp-lift"><p class="lp-eyebrow lp-blue-text">Design system</p><h3>Your components, linked</h3><p>Link your Figma components to the code's: Live's pages are drawn with yours, and each pair shows where your design and the app differ.</p></div>
      </div>
    </div>
  </section>

  <section id="selfhost" class="lp-section lp-paper">
    <div class="lp-container">
      <div class="lp-head">
        <p class="lp-eyebrow">Open source</p>
        <h2 class="lp-title-sm">Two ways <span class="lp-hl-text">to run it.</span></h2>
        <p class="lp-lead">The same CoDesignFlo either way: Live, proposals, the plugin panel, coding agents over MCP. Let us run it, or run it for your team on your own machine.</p>
      </div>
      <div class="lp-grid lp-two">
        <div class="lp-card">
          <p class="lp-eyebrow lp-blue-text">Hosted by us</p>
          <h3>Nothing to run</h3>
          <ul>
            <li>Sign in with ${signInWith} and start: install the plugin, connect your agent.</li>
            <li>Updates, backups and email notifications are taken care of.</li>
            <li>Developers free; designers ${FREE_SENDS} sends free, then a seat (<a href="#pricing" data-scroll="pricing">pricing</a>).</li>
          </ul>
          <div class="lp-card-foot"><a class="lp-button lp-primary" href="#start" data-scroll="start">Start free</a></div>
        </div>
        <div class="lp-card">
          <p class="lp-eyebrow lp-blue-text">On your own server</p>
          <h3>Free, and yours</h3>
          <ul>
            <li>One <code>docker compose up</code> on a developer's laptop, an office computer or a small cloud server.</li>
            <li>Designers and developers on different computers work through it, by its own address.</li>
            <li>No billing, no limits. Sign-in by email, invite-only, and everything stays on your server: nothing is sent to us.</li>
            <li>Each designer downloads a Figma plugin made for your server from its Set up page.</li>
          </ul>
          <div class="lp-card-foot">
            <p class="lp-note">Read the ${repoLink("/blob/main/selfhost/GUIDE.md", "self-hosting guide")}: where to run it, HTTPS, emails, backups and updates.</p>
            ${REPO_URL ? `<a class="lp-button lp-outline" href="${REPO_URL}" target="_blank" rel="noopener">View on GitHub</a>` : ""}
          </div>
        </div>
      </div>
      <p class="lp-vat">The Figma plugin, the CLI and the engine are MIT-licensed. The service and the self-hosting setup are under the Functional Source License: free for your own use, including running it for your team or your clients, not for offering a competing service; each release becomes Apache 2.0 after two years.</p>
    </div>
  </section>

  <section id="pricing" class="lp-section lp-dark lp-pricing">
    <div class="lp-container">
      <div class="lp-head">
        <p class="lp-eyebrow lp-blue-text">Pricing</p>
        <h2 class="lp-title-sm">Pay for designers. <span class="lp-hl-text">Developers are free.</span></h2>
        <p class="lp-lead lp-on-dark">Every designer sends their first ${FREE_SENDS} designs to dev for free. No card needed to start.</p>
      </div>
      <div class="lp-grid lp-two">
        <div class="lp-card">
          <p class="lp-eyebrow lp-blue-text">Developers</p>
          <p class="lp-offer"><span>Always free</span><span class="lp-offer-alt">Unlimited developers</span></p>
          <h3 class="lp-price">€0 <span class="lp-muted">per developer / month</span></h3>
          <p class="lp-small">No card, no trial. Free in every project.</p>
          <p>As many developers as you like, in every project: sync, Live, branch previews, the coding agent tools.</p>
        </div>
        <div class="lp-card">
          <p class="lp-eyebrow lp-blue-text">Designers</p>
          ${
            launchOn()
              ? `<p class="lp-offer"><span>${FREE_SENDS} sends to dev free</span><span class="lp-offer-alt">Launch price until ${LAUNCH.until}</span></p>
          <h3 class="lp-price"><s class="lp-was" aria-label="Regular price €${SEAT_EUR}">€${SEAT_EUR}</s> €${LAUNCH.eur} <span class="lp-muted">per designer / month</span></h3>
          <p class="lp-small">VAT included. For your first ${LAUNCH.months} months when you subscribe by ${LAUNCH.until}; then €${SEAT_EUR}.</p>`
              : `<p class="lp-offer"><span>${FREE_SENDS} sends to dev free</span></p>
          <h3 class="lp-price">€${SEAT_EUR} <span class="lp-muted">per designer / month</span></h3>
          <p class="lp-small">VAT included.</p>`
          }
          <p>A seat belongs to the designer and works in every project, theirs or anyone's. Pay for your own, or for your team's designers by email. Cancel any time.</p>
        </div>
      </div>
      <p class="lp-vat">${VAT_NOTE}</p>
      <p class="lp-vat">Invite a designer: their second month is free, and you get a month free when it starts. <a href="/terms">Terms</a></p>
      <p class="lp-vat">Prices are for the hosted service. On your own server, CoDesignFlo is free: no seats, no limits. <a href="#selfhost" data-scroll="selfhost">Self-hosting</a></p>
    </div>
  </section>

  <section class="lp-section lp-paper">
    <div class="lp-container">
      <div class="lp-head">
        <p class="lp-eyebrow">Good to know</p>
        <h2 class="lp-title-sm"><span class="lp-hl-text">F.A.Q.</span></h2>
      </div>
      <div id="faq" class="lp-faq">
        <div class="lp-qa"><h3>Do we need a design before we build?</h3><p>No, and that's the point. Developers and their coding agents build first; what they build shows up in Figma as <i>New in code</i>, as the app really draws it. The designer fixes what needs it and sends it back, and the agent builds the fix. Designing first works too.</p></div>
        <div class="lp-qa"><h3>What does my app need?</h3><p>A git repository with Storybook (React), and stories for your components and pages. CoDesignFlo renders them in a real browser on the developer's machine. Your code never leaves it; only what Live needs is uploaded.</p></div>
        <div class="lp-qa"><h3>Which Figma plan?</h3><p>Any, including free. The plugin runs in the Figma desktop app and adds two pages to your file: Live and Proposals (and a third, Design System, if you want it). Developers don't need Figma at all.</p></div>
        <div class="lp-qa"><h3>Who pays?</h3><p>Designers, once they send work to dev: each gets ${FREE_SENDS} free sends, then needs a seat. The seat is theirs and works in every project; they pay for it, or a team lead does in Billing. Without one, everything else keeps working. Developers are always free. A designer you invite gets their second month free, and you get a month free when it starts.</p></div>
        <div class="lp-qa"><h3>Does Figma need to stay open?</h3><p>Updates are applied by the plugin when someone has the file open. Keep Figma's window visible while it works: Figma slows plugins down in a window you can't see.</p></div>
        <div class="lp-qa"><h3>What do you collect?</h3><p>On the hosted service: how CoDesignFlo does in your project, in structure and numbers only: what failed, how long each step took, which versions ran. Your app's words, names and pictures only if your project chooses to share them. On your own server: nothing; it all stays there.</p></div>
        <div class="lp-qa"><h3>Is CoDesignFlo open source?</h3><p>Yes. The Figma plugin, the CLI and the engine are MIT. The service and the self-hosting setup are under the Functional Source License: use, change and run them for your team or your clients, just don't offer them as a competing service; each release becomes Apache 2.0 two years after it's published.</p></div>
        <div class="lp-qa"><h3>Hosted or self-hosted: which one?</h3><p>Hosted if you'd rather not run anything: sign in and start, with updates, backups and emails handled. Self-hosted if your designs and app shouldn't leave your network, or you'd rather not pay per seat: you run it with Docker, keep it updated and back it up.</p></div>
        <div class="lp-qa"><h3>We already have a design system in Figma.</h3><p>Bring it onto a Design System page: instances from your team library, or copies. Link each component to the code's (the plugin suggests the pairs), and Live's pages are drawn with yours, each pair showing where it differs from what the app draws. The code's components you haven't got wait there to be accepted, matched or ignored.</p></div>
        <div class="lp-ask"><h3>Still have a question?</h3><p>Ask our support assistant anything about CoDesignFlo, and get an answer right away.</p><a class="lp-button lp-primary" href="mailto:contact@orkestralai.com?subject=CoDesignFlo" data-chat>Chat with support</a></div>
      </div>
    </div>
  </section>

  ${footerHtml()}
</div>`;
}
