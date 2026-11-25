import { describe, expect, it } from "vitest";
import { crashSignature, gapSignature, signatureOf } from "./telemetry.js";

describe("telemetry signatures carry no app content", () => {
  it("numbers, quoted words, paths, pages, colours, ids and addresses are taken out", () => {
    expect(signatureOf(`pages.cart-page: couldn't place "Checkout" at 948×569 (#2563eb, @9e51039, p_854c2bfe462a)`)).toBe(
      "<page>: couldn't place … at #×# (<color>, @<id>, <project>)",
    );
    expect(signatureOf("Body › div › div#2 › text: font missing")).toBe("<path>: font missing");
    expect(signatureOf("sent to marta@greenthumb.com via https://x.dev/a?b=1")).toBe("sent to <email> via <url>");
  });

  it("the same problem in two projects has the same signature", () => {
    const a = gapSignature(
      "pages.inbox-agent-settings-page: differs from the app — Body › div › div#1 › div#2: 948×569 in Figma, 692×569 in the app",
    );
    const b = gapSignature("pages.cart: differs from the app — main › section › aside: 720×300 in Figma, 512×300 in the app");
    expect(a.signature).toBe("differs: frame width larger");
    expect(b.signature).toBe(a.signature);
    expect(a.data).toEqual({ figma: [948, 569], app: [692, 569], depth: 4 });
    expect(
      gapSignature("x: differs from the app — Body › p › text: 61×21 in Figma, 60×18 in the app (the text wraps or breaks differently)")
        .signature,
    ).toBe("differs: text height larger (the text wraps or breaks differently)");
  });

  it("a crash is grouped by where in CoDesignFlo it happened", () => {
    const e = new TypeError("Cannot read properties of undefined (reading 'direction')");
    e.stack = `TypeError: Cannot read properties of undefined (reading 'direction')
    at build (file:///Users/x/.npm/_npx/abc/node_modules/codesignflo/dist/main.js:1234:12)`;
    // The npx copy lives in node_modules: still its own code.
    expect(crashSignature("sync", e.message, e.stack)).toBe("sync: Cannot read properties of undefined (reading …) at build (main.js)");
    e.stack = `TypeError: x\n    at render (/app/node_modules/react-dom/index.js:9:9)`;
    expect(crashSignature("sync", e.message, e.stack)).toBe("sync: Cannot read properties of undefined (reading …)");
    e.stack = `TypeError: x\n    at Object.node (/repo/packages/core/src/compile/compile.ts:560:22)\n    at node:internal/x:1:1`;
    expect(crashSignature("sync", e.message, e.stack)).toBe(
      "sync: Cannot read properties of undefined (reading …) at Object.node (compile.ts)",
    );
  });
});
