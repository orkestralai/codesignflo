---
name: codesignflo-deliver
description: Implement a designer's CoDesignFlo proposal in code — a ready-for-dev change to an existing component, or a brand-new component designed in Figma. Use when sync reports "ready:" or "new design:", or when the user asks to apply, implement or deliver the designer's changes.
---

# CoDesignFlo deliver

The designer marked a proposal **Ready for dev** (or sent a **New design**). The CLI has already computed exactly what changed; you implement it in this session so the user sees and can steer every edit, then the CLI verifies it against the designer's copy.

Run commands from the folder that contains `.codesignflo/` (use the project's package script if it has one, e.g. `pnpm codesignflo …`).

**`deliver` takes minutes** (it runs Claude Code to build; a new page can take 10+ minutes): run it in the foreground with a long timeout (e.g. 20 minutes). Don't start it in the background and end your turn — in a headless session the job dies with the session.

**Any way of implementing works.** CoDesignFlo closes a proposal when the code does what the designer asked — however it got there (this session, by hand, a PR merged later, a ticket). The `CoDesignFlo:` line in a commit is optional: it records which commit delivered it, and lets sync send unimplemented parts back to the designer with your notes.

## 1. Make sure the changes are current

If `sync` hasn't run since the designer marked it ready, run the `codesignflo-sync` skill first.

## Clashes first

If sync said `ready: <component> — … N conflicting`, the designer changed things that the code also changed since they claimed it. Their panel warned them ("the developer changed this too") and they sent it anyway, so **their version wins by default**:

```sh
npx @codesignflo/cli resolve <component> --design
npx @codesignflo/cli sync
```

Only if the code's version must stay (a functional reason, not taste), ask the user, then `resolve <component> --code "<the reason, for the designer>"`: it goes back to the designer with that reason.

## 2a. Changes to an existing component

```sh
npx @codesignflo/cli deliver <component> --track
```

This prints a hand-off (also saved as `.codesignflo/proposals/<component>/<claim>/HANDOFF.md`): the designer's note, the files, and one line per change (`C1 [kind] layer — property: from → to (scope)`), plus the commit trailer.

Implement each change:
- Layer names are CSS-module class names (or `data-cdf` names): `body/price` is the element with class `styles.price` inside `styles.body`. `a > b` means layer `b` inside the nested component `a`.
- A layer named `<layer>-margin` (or `-margin-top` / `-margin-left`) stands for the CSS margin after (before) `<layer>`; a change to its size is a change to that margin.
- A change that uses a Figma variable which is not a project token yet ("is not a project token yet") is still the designer's decision: add the token to the project's tokens file under the name given, with the value given, and use its CSS variable. Don't swap in a similar existing token.
- Values given as tokens (`var(--space-3)`) must be used as tokens, never raw values.
- "size" changes give width/height and how it sizes (FIXED, HUG = fits content, FILL = fills its container).
- A change marked **ONLY when <variant>** must be a condition on the props that produce that variant; other variants stay unchanged. "(made in …, but applies to every version)" means apply it everywhere.
- Change only the listed files and only what is listed: no refactors, no formatting, no logic changes.
- If a change can't be implemented cleanly, don't guess: leave it out and tell the user why.

Show the user the diff, then commit **with the trailer**, listing only the change ids you implemented. Put it in the message's final block of trailers — the same paragraph as any `Co-Authored-By:` line:

```
Apply design proposal to badge

CoDesignFlo: badge claim=c123 items=C1,C2
Co-Authored-By: …
```

## 2b. A new component

```sh
npx @codesignflo/cli deliver <component>
```

For a new design this builds the component from the designer's frame (`spec.json` + `design.png` in the proposal folder) with Claude Code in a new folder next to the existing components, then commits it. Afterwards review the new files with the user (read `design.png` and compare). You can instead build it yourself in this session: read the spec and picture, follow the conventions of an existing component (including its stories file, whose title must be the component's PascalCase name), add `data-cdf` names, and commit with `CoDesignFlo: <component> claim=<id> items=new`.

Use `deliver <component>` without `--track` for existing components only when the user wants it done headless.

## 3. Verify and close

Run `codesignflo-sync`. It checks every delivered change against the designer's copy: all landed → `closed` (the designer's copy is archived); some missing → `partly delivered` and the rest goes back to the designer with your notes. For a new component, sync closes it when it appears in Storybook and reports any visual differences — then run the `codesignflo-verify` skill if the user wants them explained.
