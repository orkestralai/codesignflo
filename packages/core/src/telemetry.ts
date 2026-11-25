// What CoDesignFlo records about how it does in projects (telemetry): the event shape the CLI, the plugin and
// the hosted MCP send, and the signature that groups like events across projects. A signature carries no app
// content: numbers, quoted text, layer paths, page and component keys and addresses are taken out, so "a page
// drawn 948 wide against 692" in one project and "720 against 512" in another are the same problem.

export type TelemetrySource = "cli" | "plugin" | "mcp" | "agent";
export type TelemetryKind = "crash" | "error" | "gap" | "timing" | "setup" | "report";

export type TelemetryEvent = {
  source: TelemetrySource;
  kind: TelemetryKind;
  signature: string;
  /** The CLI's or the plugin's version. */
  version?: string;
  project?: string | null;
  /** Structure and numbers only (durations in `ms`, sizes, counts, versions). */
  data?: Record<string, unknown>;
  /** A path in the telemetry bucket (only for projects that share their content). */
  content?: string;
};

/** Text with what varies between projects taken out: what's left is the shape of the message. */
export function signatureOf(text: string): string {
  return (
    text
      // Addresses and emails, before anything inside them is touched.
      .replace(/\bhttps?:\/\/\S+/g, "<url>")
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
      // Layer paths (Body › div › …) and page/component keys (pages.cart-page, screen:pages.x).
      .replace(/[^\s›:]+(?:\s›\s[^\s›:]+)+/g, "<path>")
      .replace(/\b(?:screen:)?(?:pages|desktop|mobile)\.[\w.-]+/g, "<page>")
      // Quoted text: the app's words, or names from its code.
      .replace(/"[^"]*"|“[^”]*”|'[^']*'|‘[^’]*’|`[^`]*`/g, "…")
      // Colours, commits and ids, then any number left (sizes, counts, times).
      .replace(/#[0-9a-f]{3,8}\b/gi, "<color>")
      .replace(/\b[0-9a-f]{7,40}\b/g, "<id>")
      .replace(/\bp_[0-9a-f]+\b/g, "<project>")
      .replace(/\d+(?:[.,]\d+)?/g, "#")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300)
  );
}

/**
 * A crash's signature: where in CoDesignFlo it happened (the first frame in its own code: function and
 * file) and the shape of the message. `stack` is an Error's stack.
 */
export function crashSignature(where: string, message: string, stack?: string): string {
  const frame = (stack ?? "")
    .split("\n")
    .slice(1)
    .map((l) => /at (?:async )?([\w.$<>]+)? ?\(?(?:.*[/\\])?([\w.-]+\.(?:ts|js|mjs)):\d+/.exec(l))
    // Its own code: the repo's, or the published CLI's copy in node_modules (npx), not another package's.
    .find((m) => m && !/node:/.test(m[0]) && (!/node_modules/.test(m[0]) || /node_modules[/\\]codesignflo[/\\]/.test(m[0])));
  const at = frame ? ` at ${frame[1] ? `${frame[1]} ` : ""}(${frame[2]})` : "";
  return signatureOf(`${where}: ${message}`).slice(0, 240) + at;
}

/**
 * A difference between Live and the app, as the plugin reports it ("<path>: 948×569 in Figma, 692×569 in the
 * app (the text wraps or breaks differently)"): which kind of layer, which axis, and the reason given.
 */
export function gapSignature(line: string): { signature: string; data: Record<string, unknown> } {
  const m = /(?:^|— )(.*?): (\d+(?:\.\d+)?)×(\d+(?:\.\d+)?) in Figma, (\d+(?:\.\d+)?)×(\d+(?:\.\d+)?) in the app(?: \((.*)\))?/.exec(line);
  if (!m) return { signature: `differs: ${signatureOf(line)}`, data: {} };
  const [, path, fw, fh, aw, ah, why] = m;
  const layer = /(?:^|› )(?:text|label)$/.test(path!.trim()) ? "text" : "frame";
  const dw = Number(fw) - Number(aw);
  const dh = Number(fh) - Number(ah);
  const axis = Math.abs(dw) > 1 && Math.abs(dh) > 1 ? "size" : Math.abs(dw) > 1 ? "width" : "height";
  const way = (axis === "height" ? dh : dw) > 0 ? "larger" : "smaller";
  return {
    signature: `differs: ${layer} ${axis} ${way}${why ? ` (${signatureOf(why)})` : ""}`,
    data: { figma: [Number(fw), Number(fh)], app: [Number(aw), Number(ah)], depth: path!.split("›").length },
  };
}
