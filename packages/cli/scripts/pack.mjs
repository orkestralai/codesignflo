// Packs the CLI as one self-contained npm package for developers: core is bundled in, only real runtime
// dependencies stay external. Output: pack/codesignflo-cli-<version>.tgz (npm i -g ./that.tgz).
// Publishing to npm is done by CI on a version tag (.github/workflows/publish-cli.yml; release: pnpm release:cli).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as esbuild from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const external = ["playwright", "ws", "pngjs", "pixelmatch"];
rmSync("pack", { recursive: true, force: true });
mkdirSync("pack/cli/dist", { recursive: true });
await esbuild.build({
  entryPoints: ["src/main.ts"],
  outfile: "pack/cli/dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external,
  // Bundled CommonJS bits may call require(); give ESM output one.
  banner: { js: "import { createRequire as __cdlRequire } from 'node:module';\nconst require = __cdlRequire(import.meta.url);" },
  // The package is public: minified, so CoDesignFlo's own logic isn't laid out for reading. Licence notices stay.
  minify: true,
  legalComments: "inline",
});
cpSync("skills", "pack/cli/skills", { recursive: true });
// The Figma plugin as a template for self-hosted boxes: `codesignflo plugin build --server <box>` fills in the box's
// service and writes its manifest, so a team needs nothing but this package (packages/plugin/scripts/build.mjs).
execFileSync(process.execPath, ["scripts/build.mjs", "--flavor", "selfhost-template", "--out", resolve("pack/cli/plugin-template")], {
  cwd: "../plugin",
  stdio: ["ignore", "ignore", "inherit"],
});
cpSync("../../THIRD_PARTY.md", "pack/cli/THIRD_PARTY.md");
cpSync("README.md", "pack/cli/README.md");
cpSync("LICENSE", "pack/cli/LICENSE");
writeFileSync(
  "pack/cli/package.json",
  `${JSON.stringify(
    {
      name: "@codesignflo/cli",
      version: pkg.version,
      description:
        "CoDesignFlo CLI — keeps a Figma mirror of your Storybook in step with the code and brings designers' proposals back as code changes.",
      license: "MIT",
      private: false,
      type: "module",
      bin: { codesignflo: "dist/main.js" },
      files: ["dist", "skills", "plugin-template", "README.md", "THIRD_PARTY.md", "LICENSE"],
      engines: { node: ">=22" },
      dependencies: Object.fromEntries(external.map((d) => [d, pkg.dependencies[d]])),
      // The public npm registry: `npx @codesignflo/cli` works on any machine with nothing configured.
      publishConfig: { registry: "https://registry.npmjs.org/", access: "public" },
      repository: { type: "git", url: "git+https://github.com/orkestralai/codesignflo-private.git" },
      homepage: "https://codesignflo.com",
      keywords: ["figma", "storybook", "design", "design-to-code", "mcp", "react", "design-system", "claude-code"],
    },
    null,
    2,
  )}\n`,
);
const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", ".."], { cwd: "pack/cli", encoding: "utf8" }).trim();
console.log(`packed packages/cli/pack/${tgz}`);
