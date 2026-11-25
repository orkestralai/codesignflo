// Which components have no story: found in the folders the Storybook draws from, React components only,
// covered by a story group's component or by a stories file next to them; page stories cover nothing.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportedComponents, storyCoverage } from "./stories.js";

describe("the components a file exports", () => {
  it("React components only: functions, consts, forwardRef/memo, default and listed exports", () => {
    expect(exportedComponents(`export function Button() { return <button/> }`)).toEqual(["Button"]);
    expect(exportedComponents(`export const Badge = ({ label }) => <span>{label}</span>`)).toEqual(["Badge"]);
    expect(exportedComponents(`export const Input = React.forwardRef((p, r) => <input ref={r}/>)`)).toEqual(["Input"]);
    expect(exportedComponents(`function Card() { return <div/> }\nexport default Card;`)).toEqual(["Card"]);
    expect(exportedComponents(`const A = () => <i/>; const B = () => <b/>;\nexport { A, B as Bold }`)).toEqual(["A", "Bold"]);
    // Hooks, helpers, types and files without JSX aren't components.
    expect(exportedComponents(`export function useThing() { return 1 }\nexport type ButtonProps = {}\nexport const x = 1`)).toEqual([]);
    expect(exportedComponents(`export function Helper() { return 1 }`)).toEqual([]);
  });
});

describe("story coverage", () => {
  it("lists the app's components without stories; other apps' folders and page stories don't count", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdf-stories-"));
    const file = (p: string, s: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), s);
    };
    const jsx = (name: string) => `export function ${name}() { return <div/> }`;
    file("components/ui/Button.tsx", jsx("Button"));
    file("components/ui/Button.stories.tsx", "export default {}");
    file("components/ui/Badge.tsx", jsx("Badge"));
    file("components/studio/Dashboard.tsx", jsx("Dashboard"));
    file("components/studio/Shell.tsx", jsx("Shell"));
    file("components/hooks/useX.ts", "export function useX() {}");
    file("admin-app/components/Other.tsx", jsx("Other"));
    file(
      "storybook-static/index.json",
      JSON.stringify({
        entries: {
          "components-button--primary": { type: "story", title: "Components/Button", importPath: "./components/ui/Button.stories.tsx" },
          "components-badge--default": {
            type: "story",
            title: "UI/Badge",
            importPath: "./.storybook/stories/Badge.stories.tsx",
            componentPath: "./components/ui/Badge.tsx",
          },
          // A page story renders Dashboard, but Dashboard isn't a component in Live because of it.
          "pages-dashboard--default": {
            type: "story",
            title: "Pages/Dashboard",
            importPath: "./.storybook/stories/Dashboard.stories.tsx",
            componentPath: "./components/studio/Dashboard.tsx",
          },
        },
      }),
    );
    const c = storyCoverage(dir, join(dir, "storybook-static/index.json"));
    expect(c.files).toBe(4);
    expect(c.covered).toBe(2);
    expect(c.missing.map((m) => [m.file, m.components, m.kind])).toEqual([
      ["components/studio/Dashboard.tsx", ["Dashboard"], "block"],
      ["components/studio/Shell.tsx", ["Shell"], "panel"],
    ]);
    // Folders set in the config replace the guess.
    expect(storyCoverage(dir, join(dir, "storybook-static/index.json"), ["admin-app/components"]).missing.map((m) => m.file)).toEqual([
      "admin-app/components/Other.tsx",
    ]);
  });

  it("ranks what the pages use first (through imports, aliases and folders), building blocks before panels", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdf-rank-"));
    const file = (p: string, src: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), src);
    };
    file(
      "tsconfig.json",
      `{ // comments and globs are fine
  "compilerOptions": { "paths": { "@/*": ["./*"] }, },
  "include": ["**/*.ts", "**/*.tsx"] }`,
    );
    file("components/ui/Pill.tsx", "export function Pill() { return <span/> }");
    file("components/ui/Toast.tsx", "export function Toast() { return <div/> }");
    file("components/ui/Badge/Badge.tsx", "export default function Badge() { return <b/> }");
    file("components/ui/Badge/index.ts", "export { default } from './Badge';");
    file("components/SettingsModal.tsx", "import { Pill } from '@/components/ui/Pill';\nexport function SettingsModal() { return <div/> }");
    file(
      "app/editor/Editor.tsx",
      "import { SettingsModal } from '@/components/SettingsModal';\nimport { Pill } from '../../components/ui/Pill';\nexport default function Editor() { return <main/> }",
    );
    file(
      "app/inbox/Inbox.tsx",
      "import { Toast } from '@/components/ui/Toast';\nimport { Pill } from '@/components/ui/Pill';\nexport default function Inbox() { return <main/> }",
    );
    file(".storybook/stories/Editor.stories.tsx", "import Editor from '@/app/editor/Editor';\nexport default {}");
    file(".storybook/stories/Inbox.stories.tsx", "import Inbox from '@/app/inbox/Inbox';\nexport default {}");
    file(
      "storybook-static/index.json",
      JSON.stringify({
        entries: {
          "pages-editor--default": { type: "story", title: "Pages/Editor", importPath: "./.storybook/stories/Editor.stories.tsx" },
          "pages-inbox--default": { type: "story", title: "Pages/Inbox", importPath: "./.storybook/stories/Inbox.stories.tsx" },
          // A story whose component is a folder covers the file its index re-exports.
          "components-badge--default": {
            type: "story",
            title: "Components/Badge",
            importPath: "./.storybook/stories/Badge.stories.tsx",
            componentPath: "./components/ui/Badge",
          },
        },
      }),
    );
    const c = storyCoverage(dir, join(dir, "storybook-static/index.json"));
    expect(c.missing.map((m) => [m.file, m.pages ?? 0, m.kind])).toEqual([
      ["components/ui/Pill.tsx", 2, "block"],
      ["components/ui/Toast.tsx", 1, "block"],
      ["components/SettingsModal.tsx", 1, "panel"],
    ]);
  });
});
