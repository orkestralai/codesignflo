// Test helper: loads fixtures copied from real spike runs (packages/core/test-fixtures).
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../test-fixtures/", import.meta.url);
export const fixture = <T = unknown>(path: string): T => JSON.parse(readFileSync(new URL(path, dir), "utf8")) as T;
export const fixtureDir = (path: string) => readdirSync(new URL(path, dir));
