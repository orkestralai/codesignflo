---
name: codesignflo-verify
description: Check that the Figma Live mirror looks like the real UI, variant by variant, and explain any differences. Use when the user asks whether Figma matches the code, after delivering a new component, or when the designer reports that something in Live looks wrong.
---

# CoDesignFlo verify

```sh
npx @codesignflo/cli verify [component…] [--screens]
```

(From the folder with `.codesignflo/`; needs Figma open with the plugin, like sync. Run `codesignflo-sync` first if code changed since the last sync.)

Each variant story is screenshotted in the browser and compared with Figma's export of its Live variant. Output: one line per variant — `✓` or `!`, sizes (browser vs Figma) and the share of differing pixels — plus images in `.codesignflo/verify/<component>/<variant>.png` laid out as **browser | Figma | difference** (differences in red), and `report.json`.

For every `!` row, read its image and explain in a sentence what differs and where (e.g. "the − and + buttons are 9 px narrower in Figma", "text sits 1 px higher"). Then say which kind it is:

- **Rendering limit** (not a bug in the user's code): text anti-aliasing, sub-pixel rounding, images shown as placeholders, fonts missing in Figma. Under ~3% pixels with equal sizes is usually only this.
- **Translation gap** in CoDesignFlo (Live doesn't express some CSS yet: margins, shadows, line clamps, `line-height: normal`): Live is less faithful than the code. Note it for the CoDesignFlo maintainers; the designer should be aware when editing that component.
- **Real difference**: Live shows an older or different state — usually solved by running sync.

Never change the user's code to make Live match unless the user asks: Live is generated from the code, not the other way round.
