// Builds service/demo/seed.json, the demo's sample app: the example shop in examples/demo-app (header, footer,
// product cards, cart, promo banner… and its Home, Product and Cart pages), rendered and compiled exactly as
// `codesignflo sync` does, with its pictures (product photos, the pages' screenshots) included so the service
// can put them in the demo project's storage. Two test leftovers in the example are left out. Two stages: the
// shop as the demo starts, and after Alex ships his Free shipping badge (src/feature.ts).
// Build both Storybooks first (cd examples/demo-app && STORYBOOK_DEMO_STAGE=1 pnpm build-storybook -o
// storybook-static-1 && pnpm build-storybook), then, from packages/cli:
//   pnpm exec tsx ../../service/demo/build-seed.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, compileScreens, type Registry, tokenNames, type UpdateInput } from "@codesignflo/core";
import { renderStorybook } from "../../packages/cli/src/render/render.ts";

const app = new URL("../../examples/demo-app/", import.meta.url).pathname;
const LEFT_OUT = { components: ["knowledge-base-popup-import-from-website"], screens: ["pages.main-content-canvas-page"] };

const dtcg = JSON.parse(readFileSync(join(app, "tokens/tokens.json"), "utf8"));
const tokens = tokenNames(dtcg);

/** One stage of the shop, rendered and compiled as a sync would, with the pictures it uses. */
async function stage(dir: string, commit: string) {
  const { registry: auto, irs, images, failed, shots: shotsByStory } = await renderStorybook(join(app, dir), app);
  if (failed.size) throw new Error(`stories failed: ${[...failed.keys()].join(", ")}`);
  for (const k of LEFT_OUT.components) delete (auto.components as Record<string, unknown>)[k];
  for (const k of LEFT_OUT.screens) delete (auto.screens as Record<string, unknown>)[k];
  const registry = auto as unknown as Registry & { screens: NonNullable<Registry["screens"]> };
  const sets = compile(registry, irs, tokens);
  const screens = compileScreens({ ...registry, screens: registry.screens ?? {} }, irs, tokens).map((x) => ({ spec: x.spec, coverage: x.coverage }));
  const shots = Object.fromEntries(
    Object.entries(registry.screens ?? {}).flatMap(([key, sc]) => {
      const shot = shotsByStory.get(sc.story);
      return shot ? [[key, shot] as const] : [];
    }),
  );
  // Only the pictures this update uses (the left-out stories' go).
  const used = JSON.stringify({ sets, screens, shots });
  const pictures = Object.fromEntries([...images].filter(([ref]) => used.includes(ref)));
  const update: UpdateInput = {
    sets,
    screens,
    shots,
    dtcg,
    commit,
    keys: [...Object.keys(registry.components), ...Object.keys(registry.screens ?? {})],
    deliveries: [],
    media: Object.keys(pictures),
  };
  return { update, registry: auto, pictures };
}

// 1: the shop as the demo starts. 2: after Alex ships the Free shipping badge (built first, no design yet).
const first = await stage("storybook-static-1", "demo-1");
const second = await stage("storybook-static", "demo-2");
const pictures = { ...first.pictures, ...second.pictures };
writeFileSync(
  new URL("seed.json", import.meta.url),
  `${JSON.stringify({ update: first.update, registry: first.registry, update2: second.update, registry2: second.registry, pictures })}\n`,
);
const kb = (s: string) => Math.round(Buffer.byteLength(s) / 1024);
for (const [n, x] of [["1", first], ["2", second]] as const)
  console.log(
    `stage ${n}: ${x.update.sets.length} components (${x.update.sets.map((s) => s.k).join(", ")}), pages ${Object.keys(x.registry.screens ?? {}).join(", ")}; code ${kb(JSON.stringify({ sets: x.update.sets, screens: x.update.screens }))} KB`,
  );
console.log(`${Object.keys(pictures).length} pictures (${kb(Object.values(pictures).join(""))} KB)`);
