// Minimal DTCG -> CSS custom properties. Deterministic: keys are emitted in sorted order.
import { readFileSync, writeFileSync } from "node:fs";

const tokens = JSON.parse(readFileSync(new URL("../tokens/tokens.json", import.meta.url), "utf8"));
const lines = [];

function walk(node, path) {
  if (node && typeof node === "object" && "$value" in node) {
    const v = Array.isArray(node.$value) ? node.$value.join(", ") : String(node.$value);
    lines.push(`  --${path.join("-")}: ${v};`);
    return;
  }
  for (const key of Object.keys(node).filter((k) => !k.startsWith("$")).sort()) walk(node[key], [...path, key]);
}

walk(tokens, []);
writeFileSync(
  new URL("../src/tokens.css", import.meta.url),
  `/* Generated from tokens/tokens.json. Do not edit. */\n:root {\n${lines.join("\n")}\n}\n`,
);
