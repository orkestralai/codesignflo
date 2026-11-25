---
name: codesignflo-sync
description: Keep the Figma "Live" mirror in step with the code and pick up the designer's work (CoDesignFlo). Use at the end of any task that changed UI components, pages, styles or tokens in a project with a .codesignflo/ folder; when the user asks what the designer did, whether design and code are in sync, or to sync with Figma; and before delivering design changes.
---

# CoDesignFlo sync

CoDesignFlo keeps a Figma file in two parts: **Live** (generated from the code's Storybook — never edited by hand) and **Proposals** (the designer's copies). `sync` is the developer side of the loop. Everything deterministic is done by the CLI; your job is to run it at the right moment and explain the result.

## Run it

From the folder that contains `.codesignflo/` (the app folder):

```sh
CODESIGNFLO_WAIT_S=40 npx @codesignflo/cli sync
```

Use the project's package script instead if it defines one (e.g. `pnpm codesignflo sync`). It builds Storybook, renders it, and needs **Figma desktop open on the project's file with the CoDesignFlo plugin running**. If it says the plugin did not connect, tell the user to open the plugin in Figma (Plugins → Development → CoDesignFlo) and offer to retry — do not retry in a loop.

If it says Live mirrors another branch: syncing from a feature branch would show unmerged code to the designer. Explain this; only pass `--allow-branch` if the user explicitly wants it.

## Explain the output

Report in plain language, most important first:

- `ready: <component> — N code change(s)` → the designer finished a proposal. Offer to deliver it (skill `codesignflo-deliver`). Mention "conflicting" counts: code changed under the designer in the same places.
- `new design: <component> …` → the designer drew a component that doesn't exist in code yet. Offer to build it (`codesignflo-deliver`).
- `designer: <component> claimed / ready / unclaimed (…)` → what the designer did since the last sync.
- `closed: …` → a delivered proposal was verified against the designer's copy and closed. `partly delivered` → some changes were sent back to the designer with questions; say which.
- `! <component>: Live had been edited by hand …` → someone edited Live directly; it was saved as a proposal before Live was regenerated. Nothing is lost; the designer can continue from that proposal.
- `N element(s) without a semantic name — run: codesignflo name` → offer to run it (it adds `data-cdf` attributes; review the diff with the user).
- `updated` / `created` lines → Live now reflects the code changes; the designer sees them as "Changed in code".

## After syncing

`sync` writes files under `.codesignflo/` (ledger, snapshots, registry, `STATUS.md`). They are part of the project's history: include them in the commit with the code change that caused them (or commit them on their own: "codesignflo sync").
