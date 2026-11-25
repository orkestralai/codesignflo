---
name: codesignflo-status
description: Answer questions about the state of design and code in a CoDesignFlo project without touching Figma — which components the designer is working on, what is ready for dev, what changed in code. Use when the user asks for the design status, open proposals, or what is waiting on them.
---

# CoDesignFlo status

Read `.codesignflo/STATUS.md` (written by the last sync). Each row is a component:

| State | Meaning | Who acts |
|---|---|---|
| In sync | Live matches the code; no open proposal | — |
| Changed in code | code changed since the designer last looked | designer (review in Figma) |
| In design | the designer is editing a copy | designer |
| Ready for dev | the designer's proposal waits for implementation | developer → `codesignflo-deliver` |
| New design | a component designed in Figma, not in code yet | developer → `codesignflo-deliver` |
| New in code | built in code without a design | designer (accept, ignore or redesign) |
| Needs a look | code changed in the same places the designer edited | both: talk before delivering |
| Ignored | the designer said it needs no design | — |

Summarise what is waiting on the developer first, with the designer's notes. Mention the time of the last sync (`.codesignflo/state.json` has its commit); if the user needs the designer's latest actions, they appear only after a new sync — offer `codesignflo-sync`.

Details per proposal live in `.codesignflo/proposals/<component>/<claim>/` (`changes.json`, `HANDOFF.md`, `report.json`); the full history is `.codesignflo/events.jsonl` (one JSON event per line).
