// The footer (adapted from OrkestralAI's) and the legal pages: privacy policy, terms and impressum. CoDesignFlo
// is run by OrkestralAI UG; the impressum is OrkestralAI's, the policy and terms are OrkestralAI's adapted to
// what CoDesignFlo does and stores. Have them reviewed before relying on them.

import { logoSvg } from "./logo.ts";

export const LEGAL_PAGES = ["privacy", "terms", "impressum", "cookies", "security"] as const;
export type LegalPage = (typeof LEGAL_PAGES)[number];
export const LEGAL_TITLES: Record<LegalPage, string> = {
  privacy: "Privacy policy",
  terms: "Terms",
  impressum: "Impressum",
  cookies: "Cookies and storage",
  security: "Security",
};

const CONTACT = "contact@orkestralai.com";
const UPDATED = "Last updated: November 25th, 2026";
const mail = `<a href="mailto:${CONTACT}">${CONTACT}</a>`;

export function footerHtml(): string {
  return `<footer class="lp-footer">
  <div class="lp-container lp-footer-grid">
    <div>
      <a href="#/" class="lp-brand lp-footer-brand">${logoSvg(26)}CoDesignFlo</a>
      <p class="lp-footer-tagline">Your app in Figma, always as built. Your designs in code, through your coding agent.</p>
      <a class="lp-footer-by" href="https://orkestralai.com" target="_blank" rel="noreferrer">
        <span>Brought to you by</span>
        <span class="lp-footer-org"><img src="/orkestralai.svg" alt="" width="36" height="36">OrkestralAI</span>
      </a>
    </div>
    <div>
      <p class="lp-footer-head">Explore</p>
      <ul>
        <li><a href="#/" data-scroll="how">How it works</a></li>
        <li><a href="#/" data-scroll="start">Get started</a></li>
        <li><a href="#/" data-scroll="pricing">Pricing</a></li>
        <li><a href="#/docs/designers">Docs for designers</a></li>
        <li><a href="#/docs/developers">Docs for developers</a></li>
        <li><a href="#/" data-scroll="faq">Good to know</a></li>
        <li><a href="#/signin">Sign in</a></li>
      </ul>
    </div>
    <div>
      <p class="lp-footer-head">Connect</p>
      <ul>
        <li><a href="mailto:${CONTACT}">Contact us</a></li>
        <li><a href="https://x.com/orkestralai" target="_blank" rel="noreferrer">Twitter/X</a></li>
        <li><a href="https://linkedin.com/company/orkestral-ai" target="_blank" rel="noreferrer">LinkedIn</a></li>
        <li><a href="https://orkestralai.com" target="_blank" rel="noreferrer">OrkestralAI</a></li>
      </ul>
    </div>
    <div>
      <p class="lp-footer-head">Legal</p>
      <ul>
        <li><a href="/privacy">Privacy policy</a></li>
        <li><a href="/terms">Terms</a></li>
        <li><a href="/impressum">Impressum</a></li>
        <li><a href="/cookies">Cookies and storage</a></li>
        <li><a href="/cookies" data-consent-open>Cookie settings</a></li>
        <li><a href="/security">Security</a></li>
      </ul>
    </div>
  </div>
  <div class="lp-container lp-footer-bottom">
    <span>&copy; ${new Date().getFullYear()} OrkestralAI. All rights reserved.</span>
    <span>Built for designers and developers</span>
  </div>
</footer>`;
}

export const page = (eyebrow: string, title: string, highlight: string, body: string) => `<section class="lp-section lp-paper lp-legal">
  <div class="lp-container">
    <div class="lp-card lp-legal-card">
      <p class="lp-eyebrow" style="text-align:center">${eyebrow}</p>
      <h1 class="lp-title-sm" style="text-align:center">${title} <span class="lp-hl-text">${highlight}</span></h1>
      ${body}
    </div>
  </div>
</section>`;

export const list = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

const CONTROLLER = "OrkestralAI UG (haftungsbeschränkt), c/o Red Tape Translation UG (haftungsbeschränkt), Berliner Straße 69, 13189 Berlin, Germany";

function privacy(): string {
  return page(
    "Legal",
    "Privacy",
    "Policy",
    `<p class="lp-muted">${UPDATED}</p>
    <p>This policy explains what CoDesignFlo (the website at codesignflo.com, its Figma plugin, its command-line tool and the service they use) collects, why, on what legal basis, who receives it, how long it's kept, and your rights.</p>
    <h2>1. Who is responsible</h2>
    <p>The controller under the EU General Data Protection Regulation (GDPR) is ${CONTROLLER}. Contact: ${mail}.</p>
    <h2>2. Information we collect</h2>
    ${list([
      "<b>Your account:</b> when you sign in with Figma, Google or GitHub, your email address, your name as those services give it, and an identifier from them; with your email (a password or a sign-in link), your email address, and your password stored only as a one-way hash we can't read back. We never see your password for Figma, Google or GitHub.",
      "<b>Your projects:</b> each project's name and members (with their roles), the link to its repository (its first commit and folder, not its code), its settings, and its history: what designers and developers did (claimed, sent to dev, implemented, reviewed), who did it and when.",
      "<b>What Live shows:</b> when a developer syncs, the command-line tool renders the app's Storybook on their own machine and uploads what Live needs: the layout and text of its components and pages, their styles and tokens, which files and stories they come from, the app's images and a screenshot of each page. The app's source code is never uploaded.",
      "<b>Designs:</b> the proposals designers send from Figma, as layers and changes, for the developer's coding agent to implement.",
      "<b>Billing:</b> for whoever pays, the designer seats they pay for (the email addresses they add, including people who haven't signed up yet), and the subscription's state from Stripe. Card details go to Stripe only; we never see them.",
      "<b>Referrals:</b> who invited whom (by link or project invitation), whether the invited designer's payments qualify, the credits given, and, to stop self-referrals, the fingerprint Stripe gives the card or account that paid (an identifier, never the card's number). We keep the emails and Figma accounts that have paid before, so only people new to CoDesignFlo count.",
      "<b>How CoDesignFlo performs (telemetry):</b> what failed and where in CoDesignFlo, how long each step took, which versions and browser ran, and where Live differs from the app, by kind and size. Only structure and numbers, not your app's words, names or pictures, unless your project's developers choose to share content in the project's settings.",
      "<b>Website visits (only with your consent):</b> a count of page views by ship-or-die.com, see section 6.",
      "<b>Technical information:</b> when the Figma plugin was last open in a file (so a sync can wait for it), and what our hosting providers log when you use a website or an API (IP address, browser, time), kept for a short time for security.",
    ])}
    <h2>3. Why we use it, and on what legal basis</h2>
    ${list([
      "<b>To provide CoDesignFlo</b> (your account, projects, Live, designs, sign-in, the emails a project needs such as invitations, and billing): performance of our contract with you, Art. 6(1)(b) GDPR.",
      "<b>To keep it secure and working, and to improve it</b> (security logs, abuse prevention, telemetry, activity notifications you can turn off): our legitimate interests in a secure, reliable service, Art. 6(1)(f) GDPR.",
      "<b>To count website visits</b>: your consent, Art. 6(1)(a) GDPR, which you can withdraw at any time (\"Cookie settings\" in the footer).",
      "<b>To keep invoices and accounting records</b>: legal obligations, Art. 6(1)(c) GDPR.",
    ])}
    <h2>4. Your projects' data</h2>
    ${list([
      "A project's data is visible to that project's members only, as their role allows (designers, developers, admins).",
      "You are responsible for the content you put in your projects and the apps you connect. For personal data in your projects, we process it on your behalf to provide the service.",
      "We don't access, use or disclose your projects' data except as needed to provide the service, or as described here.",
      "A project's owner can delete the project with its history, proposals and Live versions at any time; your Figma file and your code stay as they are.",
    ])}
    <h2>5. Signing in with Google</h2>
    ${list([
      "If you sign in with Google, we receive from Google only your name, your email address and your profile picture (the scopes openid, email and profile). We use them only to create your account, sign you in and show who you are to the people in your projects.",
      "We don't sell Google user data, use it for advertising, or use it to develop, improve or train AI or machine-learning models, and we don't transfer it to anyone except the providers that run the service (section 6) as needed to provide it.",
      "CoDesignFlo's use and transfer of information received from Google APIs adheres to the <a href=\"https://developers.google.com/terms/api-services-user-data-policy\" target=\"_blank\" rel=\"noopener\">Google API Services User Data Policy</a>, including the Limited Use requirements.",
      "You can remove CoDesignFlo's access at any time in your Google account (Security › Your connections to third-party apps), and ask us to delete your account (section 10).",
    ])}
    <h2>6. Who receives it</h2>
    ${list([
      "<b>Service providers</b> that run CoDesignFlo for us under data processing agreements: Supabase (database, sign-in and file storage), Vercel (website and service hosting), Stripe (payments; Stripe is also responsible on its own for payment and fraud checks) and Google (Google Workspace: sending our invitation and notification emails).",
      "<b>Figma and GitHub</b>, only to sign you in, under their own privacy policies.",
      "<b>ship-or-die.com</b>, only if you allow visit counting (section 6).",
      "Authorities or others where the law requires it, or to protect our rights, or in connection with a merger, acquisition or sale of assets.",
    ])}
    <p><b>Where it's processed:</b> your account and project data are stored and processed in the EU: the database and file storage with Supabase in Ireland (AWS eu-west-1), and the service with Vercel in Dublin. Emails are sent through Google's servers, Stripe processes payments in the EU and the United States, and the website's static pages are delivered from Vercel's network nearest to you.</p>
    <p>We don't sell your information. Some providers process data outside the European Economic Area, in particular in the United States. Where they do, transfers rely on the EU–US Data Privacy Framework or on the European Commission's Standard Contractual Clauses.</p>
    <h2>7. Cookies, browser storage and visit counting</h2>
    <p>CoDesignFlo sets no cookies. The website keeps only what it needs to work in your browser's storage: your sign-in and your choices. The fonts are served from codesignflo.com itself. With your consent, the website also counts page views with ship-or-die.com (no cookies, no identifiers; it sends the page, the referring site and campaign tags, and ship-or-die.com sees your IP address). See <a href="/cookies">Cookies and storage</a> for every item, and change your choice any time with <a href="/cookies" data-consent-open>Cookie settings</a>.</p>
    <h2>8. How long we keep it</h2>
    ${list([
      "Account and project data: while your account or the project exists. When you ask us to delete your account, we erase its data within 30 days, except what other members of a shared project still need (such as the history of what you did there) and what the law requires us to keep.",
      "Telemetry: 90 days.",
      "Invoices and accounting records: as long as German commercial and tax law requires (up to 10 years).",
      "Hosting and security logs: as briefly as our providers allow, usually days to weeks.",
    ])}
    <h2>9. Security</h2>
    <p>We take reasonable measures to protect your information from unauthorized access and disclosure: everything travels encrypted, each project's data is reachable only by its members, and pictures are kept in private storage. No method of transmission or storage is 100% secure, so we cannot guarantee absolute security.</p>
    <h2>10. Your rights</h2>
    <p>You have the right to access your personal data, to have it corrected or deleted, to restrict its processing, to receive it in a portable format, and to object to processing based on our legitimate interests. Where we rely on your consent, you can withdraw it at any time without affecting what was done before. Developers can turn telemetry off for their command-line tool (<code>CODESIGNFLO_TELEMETRY=off</code>). To exercise your rights, write to ${mail}. You can also complain to a data protection supervisory authority, for example the Berlin Commissioner for Data Protection and Freedom of Information.</p>
    <h2>11. Children</h2>
    <p>CoDesignFlo is a tool for professionals and isn't meant for anyone under 16.</p>
    <h2>12. Changes to this policy</h2>
    <p>We may update this policy to reflect changes in CoDesignFlo or for legal reasons. The updated policy is posted here with its date.</p>
    <h2>13. Contact</h2>
    <p>For questions or requests about this policy or your information: ${mail}.</p>`,
  );
}

function cookies(): string {
  const row = (name: string, where: string, what: string, how: string, kind: string) =>
    `<tr><td><code>${name}</code></td><td>${where}</td><td>${what}</td><td>${how}</td><td>${kind}</td></tr>`;
  return page(
    "Legal",
    "Cookies and",
    "storage",
    `<p class="lp-muted">${UPDATED}</p>
    <p><b>CoDesignFlo sets no cookies.</b> The website keeps a few things in your browser's local storage so it works, loads its fonts from codesignflo.com itself, and counts visits only if you allow it. Here is everything, and you can change your choice any time: <a href="/cookies" data-consent-open>Cookie settings</a>.</p>
    <h2>Stored in your browser</h2>
    <div class="lp-table"><table><tr><th>Name</th><th>Where</th><th>What for</th><th>How long</th><th>Type</th></tr>
    ${row("sb-…-auth-token", "Local storage, codesignflo.com", "Keeps you signed in", "Until you sign out", "Strictly necessary")}
    ${row("cdf.consent", "Local storage, codesignflo.com", "Remembers your choice about visit counting", "Until you change it or clear your browser", "Strictly necessary")}
    ${row("cdf.agent", "Local storage, codesignflo.com", "Remembers which coding agent's setup you looked at", "Until you clear your browser", "Functional, set when you choose")}
    ${row("cdf.ref", "Local storage, codesignflo.com", "Remembers the designer's referral link you opened, so your new account counts as invited by them", "Until you sign in", "Functional, set when you open a referral link")}
    </table></div>
    <h2>Only with your consent</h2>
    <div class="lp-table"><table><tr><th>Service</th><th>What it does</th><th>What it receives</th><th>Stores</th></tr>
    <tr><td>ship-or-die.com</td><td>Counts page views (a startup competition's traffic check)</td><td>The page, the referring site, campaign tags (utm), and your IP address</td><td>Nothing: no cookies, no identifiers. It also skips browsers that send Global Privacy Control.</td></tr>
    </table></div>
    <h2>Elsewhere</h2>
    ${list([
      "<b>Signing in</b> with Figma, Google or GitHub happens on their websites, with their own cookies.",
      "<b>Paying</b> happens on Stripe's checkout and billing pages, with Stripe's own cookies (used for payments and fraud prevention).",
      "<b>The Figma plugin</b> keeps your sign-in in Figma's plugin storage on your device.",
      "<b>The command-line tool</b> keeps your sign-in in a file in your home folder.",
    ])}
    <p>More in the <a href="/privacy">privacy policy</a>.</p>`,
  );
}

function terms(): string {
  return page(
    "Legal",
    "Terms and",
    "Conditions",
    `<p class="lp-muted">${UPDATED}</p>
    <p>Welcome to CoDesignFlo, a service of OrkestralAI. By accessing or using CoDesignFlo (its website, Figma plugin, command-line tool and service) you agree to be bound by these terms. Please read them carefully.</p>
    <h2>1. Acceptance of terms</h2>
    <p>By using CoDesignFlo, you agree to comply with and be legally bound by these terms and all applicable laws and regulations. If you do not agree with any part of them, you must not use CoDesignFlo.</p>
    <h2>2. The service</h2>
    ${list([
      "Keep a Figma copy of your app (Live) in step with its code, rendered from its Storybook.",
      "Let designers propose changes in Figma and send them to the developers.",
      "Give developers' coding agents those proposals as instructions, through CoDesignFlo's MCP server and command-line tool, and record when the code implements them.",
      "Collaborate on projects with the people you invite.",
    ])}
    <h2>3. Plans and payment</h2>
    ${list([
      "Developers use CoDesignFlo for free. Designers need a designer seat: €25 a month per seat, VAT included, billed monthly through Stripe. A seat belongs to one person (their email) and can be used in any project. It can be paid by that person or by someone else on their behalf. Businesses in the EU outside Germany with a valid VAT ID are invoiced the same amount without VAT (reverse charge). Launch offer: subscriptions started by 15 December 2026 pay €15 a month per seat, VAT included, for their first 6 months, then €25.",
      "Every designer gets 5 free sends to developers (each Ready for dev or new design is one, re-sends included), with no time limit. After that, a designer without a seat can keep using CoDesignFlo, but designs they send to developers wait until they have a seat. Nothing is deleted.",
      "Whoever pays can add or remove seats at any time; changes are prorated. You can cancel at any time from Billing; the subscription then ends at the end of the period already paid.",
      "We may offer CoDesignFlo for free to some people or organizations at our discretion.",
    ])}
    <h2>4. Referrals</h2>
    ${list([
      "A designer can invite other designers through their personal link (in Billing) or by inviting them to a project as designers. Only people new to CoDesignFlo count: a new account that never had a subscription or a paid seat. Each designer counts for the first designer who invited them only.",
      "The invited designer's second month is free: after their first paid month, one month of their seat is credited to whoever pays it.",
      "The designer who invited them gets one month free when the invited designer's second month starts (their first renewal), as a credit on their next invoice. At most 12 free months a year. Months earned before subscribing wait as a credit and expire 12 months after they're earned.",
      "No self-referral: inviting yourself, paying the invited designer's seat yourself or with the same Stripe account or card earns nothing. A refund or a payment dispute before the inviter's free month voids the referral. Accounts on our free list never count.",
      "Credits have no cash value. We may void referrals and credits that abuse these rules, and change or end the referral program for the future.",
    ])}
    <h2>5. Your responsibilities</h2>
    ${list([
      "You are responsible for the content you put in CoDesignFlo and for the apps and files you connect to it, and for having the right to do so.",
      "You must not use CoDesignFlo for any unlawful, harmful or abusive activity, or to interfere with the service or other users.",
      "You must not use CoDesignFlo to create, store or share sexual or intimate imagery of anyone without their consent, including AI-generated imagery, or any sexual content involving minors. We remove such content and close the accounts involved.",
      "You are responsible for keeping your accounts and your coding agent's access secure.",
    ])}
    <h2>6. Intellectual property</h2>
    ${list([
      "CoDesignFlo, its content and its trademarks, except what users create, belong to OrkestralAI or its licensors.",
      "You keep ownership of your code, designs and content. You grant OrkestralAI a license to store, process and display them as needed to provide CoDesignFlo to you and the members of your projects.",
    ])}
    <h2>7. Privacy</h2>
    <p>Your privacy matters to us. Please read our <a href="/privacy">privacy policy</a> to understand how we collect, use and protect your information.</p>
    <h2>8. Limitation of liability</h2>
    <p>CoDesignFlo is provided "as is" and "as available". We do not guarantee that it will be error-free or uninterrupted, or that Live will match your app exactly. To the fullest extent permitted by law, OrkestralAI and its affiliates are not liable for any indirect, incidental or consequential damages arising from your use of CoDesignFlo.</p>
    <h2>9. Third-party services</h2>
    <p>CoDesignFlo works with third-party services such as Figma, GitHub and coding agents. We are not responsible for their content, policies or practices.</p>
    <h2>10. Changes to these terms</h2>
    <p>We may update these terms from time to time. Changes will be posted on this page with the updated date. Continuing to use CoDesignFlo means you accept them.</p>
    <h2>11. Termination</h2>
    <p>We may suspend or end your access to CoDesignFlo, at our discretion and without notice, for conduct we believe violates these terms or harms other users or the service.</p>
    <h2>12. Contact</h2>
    <p>For questions about these terms: ${mail}.</p>`,
  );
}

/** How to report a vulnerability, and what we do with a report (the internal side: docs/SECURITY.md). */
function security(): string {
  return page(
    "Security",
    "Report a",
    "vulnerability",
    `<p class="lp-muted">${UPDATED}</p>
    <p>We want CoDesignFlo to be safe for the designers and developers who trust it with their work. If you think you've found a security vulnerability in the Figma plugin, the command-line tool (npm <code>codesignflo</code>), the website or the service behind them, please tell us. We'll work with you to understand it and fix it quickly.</p>
    <h2>How to report</h2>
    ${list([
      `Email ${mail} with "Security" in the subject.`,
      "Describe the issue, the steps to reproduce it, what an attacker could do with it, and the versions or addresses involved. A proof of concept helps.",
      "Please don't share the issue publicly until we've fixed it and agreed a date with you.",
    ])}
    <h2>What happens next</h2>
    ${list([
      "We confirm we've received your report within 3 business days.",
      "We assess it and tell you what we found within 10 business days.",
      "We aim to fix critical issues within 7 days, high within 30 days, and others within 90 days, and we keep you updated until it's fixed.",
      "With your permission, we thank you by name when we announce the fix. We don't run a paid bug bounty.",
    ])}
    <h2>In scope</h2>
    ${list([
      "codesignflo.com and its sign-in, approval and billing pages",
      "The CoDesignFlo service: its API, the hosted MCP server, and how it stores projects, proposals and accounts",
      "The CoDesignFlo Figma plugin and the <code>codesignflo</code> command-line tool, including its local connection to the plugin",
    ])}
    <h2>Please don't</h2>
    ${list([
      "Access, change or delete data that isn't yours: use your own accounts and projects, and stop and tell us if you reach someone else's data.",
      "Degrade the service (denial of service, load testing, spamming invitations or emails).",
      "Use social engineering, phishing or physical attacks against us or our users.",
      "Report issues in Figma, GitHub, Stripe, Supabase or Vercel themselves: please report those to them.",
    ])}
    <p>Low-impact findings without a demonstrated security consequence (missing best-practice headers on static pages, rate limits on harmless endpoints, self-XSS, clickjacking on pages with no sensitive action) are out of scope.</p>
    <h2>Safe harbor</h2>
    <p>If you act in good faith and follow this policy, we consider your research authorized, we won't take legal action against you or ask anyone else to, and we'll work with you to resolve the issue. If in doubt, ask us first at ${mail}.</p>
    <h2>If your data is affected</h2>
    <p>If a vulnerability exposed personal data, we notify the competent data protection authority within 72 hours of becoming aware of it, as the GDPR requires, and we tell the people affected without undue delay when the risk to them is high.</p>`,
  );
}

function impressum(): string {
  return page(
    "Legal",
    "",
    "Impressum",
    `<p>Legal Disclosure / Anbieterkennzeichnung gemäß § 5 DDG</p>
    <h2>Responsible for this website</h2>
    <p><b>OrkestralAI UG (haftungsbeschränkt)</b><br>c/o Red Tape Translation UG (haftungsbeschränkt)<br>Berliner Straße 69, 13189 Berlin, Germany</p>
    <h2>Contact</h2>
    <p>E-Mail: ${mail}</p>
    <h2>VAT ID</h2>
    <p>VAT identification number according to § 27 a Umsatzsteuergesetz:<br>DE462549582</p>
    <h2>Disclaimer</h2>
    ${list([
      "Despite careful content control, we assume no liability for the content of external links. The operators of the linked pages are solely responsible for their content.",
      "The content of this website was created with great care. However, we cannot guarantee the accuracy, completeness, or timeliness of the content.",
    ])}
    <h2>Copyright</h2>
    <p>All content and works on these pages created by the site operators are subject to German copyright law. Duplication, processing, distribution, or any form of commercialization of such material beyond the scope of the copyright law shall require the prior written consent of its respective author or creator.</p>`,
  );
}

/** A legal page with the landing page's header and footer. */
export function legalHtml(which: LegalPage): string {
  const body = which === "privacy" ? privacy() : which === "terms" ? terms() : which === "cookies" ? cookies() : which === "security" ? security() : impressum();
  return `<div class="lp">
  <header class="lp-top">
    <a href="#/" class="lp-brand">${logoSvg(26)}CoDesignFlo</a>
    <span class="grow"></span>
    <a href="#/signin" class="lp-button lp-small">Sign in</a>
  </header>
  ${body}
  ${footerHtml()}
</div>`;
}
