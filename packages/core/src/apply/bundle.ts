// A Live update's compiled code (components and pages) travels through the service gzipped, as base64: a big
// app's pages are megabytes of JSON, too slow for the database to store as JSON. The CLI packs it (node:zlib);
// the plugin unpacks it here (DecompressionStream, in the browser and in Node alike).
import type { UpdateInput } from "./apply.js";

export type Bundle = Pick<UpdateInput, "sets" | "screens">;

// Core builds without the DOM's types: the few browser globals it uses, as Node 18+ and browsers have them.
type Streams = {
  atob(s: string): string;
  Blob: new (parts: Uint8Array[]) => { stream(): { pipeThrough(t: unknown): unknown } };
  DecompressionStream: new (format: "gzip") => unknown;
  Response: new (body: unknown) => { text(): Promise<string> };
};

export async function unpackBundle(b64: string): Promise<Bundle> {
  const g = globalThis as unknown as Streams;
  const bin = g.atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new g.Blob([bytes]).stream().pipeThrough(new g.DecompressionStream("gzip"));
  return JSON.parse(await new g.Response(stream).text()) as Bundle;
}
