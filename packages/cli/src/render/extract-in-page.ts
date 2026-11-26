// Runs inside the Storybook iframe (Playwright page.evaluate). Must be self-contained: no imports
// at runtime, only types. Walks the rendered component and returns an IRNode tree.
import type { IRNode, Sizing, Tokened } from "@codesignflo/core";

export function extractInPage(): IRNode {
  // data-cdl(-container) is the attribute's name before the rename to CoDesignFlo; both are read.
  const container = (document.querySelector("[data-cdf-container], [data-cdl-container]") ??
    document.querySelector("#storybook-root")) as HTMLElement;
  const root = container.firstElementChild as HTMLElement;
  if (!root) throw new Error("story rendered nothing");

  // ---- layout-intent probe: render the container at two widths; whatever tracks it is "fill". ----
  const all = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  const original = container.style.width;
  const widthsAt = (w: number) => {
    container.style.width = `${w}px`;
    return new Map(all.map((el) => [el, el.getBoundingClientRect().width]));
  };
  const before = new Map(all.map((el) => [el, el.getBoundingClientRect()]));
  // Widen from the real width (never squeeze: squeezing makes text wrap and everything looks like "fill").
  const w0 = Math.round(container.getBoundingClientRect().width);
  const wA = widthsAt(w0);
  const wB = widthsAt(w0 + 160);
  container.style.width = original;

  // ---- declared CSS (to recover tokens and explicit sizes, which computed styles lose) ----
  // In cascade order, with what's inside @layer and @supports, and media queries that apply at this size
  // (responsive classes: Tailwind's lg:w-auto and 2xl:w-[360px] are what count at 1728px, not w-full).
  const rules: CSSStyleRule[] = [];
  const collect = (list: CSSRuleList) => {
    for (const r of Array.from(list)) {
      if (r instanceof CSSStyleRule) rules.push(r);
      else if (r instanceof CSSMediaRule) {
        if (window.matchMedia(r.conditionText || r.media.mediaText).matches) collect(r.cssRules);
      } else if (r instanceof CSSSupportsRule) {
        if (CSS.supports(r.conditionText)) collect(r.cssRules);
      } else if ("cssRules" in r && (r as CSSGroupingRule).cssRules) collect((r as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    collect(list);
  }
  const declared = (el: Element, prop: string): string => {
    let v = (el as HTMLElement).style?.getPropertyValue(prop) ?? "";
    if (v) return v.trim();
    for (const r of rules) {
      let matches = false;
      try {
        matches = el.matches(r.selectorText);
      } catch {}
      if (matches) {
        const x = r.style.getPropertyValue(prop);
        if (x) v = x;
      }
    }
    return v.trim();
  };
  /** Inherited properties (color, font-*) may be declared on an ancestor. */
  const declaredUp = (el: Element, prop: string): string => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const v = declared(e, prop);
      if (v) return v;
    }
    return "";
  };
  const tokenIn = (v: string) => /var\(--([\w-]+)\)/.exec(v)?.[1];
  /** Longhand value, falling back to the shorthand (longhands read empty when the shorthand uses var()). */
  const sideToken = (el: Element, shorthand: string, side: 0 | 1 | 2 | 3, longhand: string) => {
    const l = declared(el, longhand);
    if (l) return tokenIn(l);
    const parts = declared(el, shorthand)
      .split(/\s+(?![^(]*\))/)
      .filter(Boolean);
    if (parts.length === 0) return undefined;
    const idx = [
      [0, 0, 0, 0],
      [0, 1, 0, 1],
      [0, 1, 2, 1],
      [0, 1, 2, 3],
    ][Math.min(parts.length, 4) - 1]![side]!;
    return tokenIn(parts[idx]!);
  };

  const round = (n: number) => Math.round(n * 100) / 100;
  const px = (v: string) => (v === "normal" || v === "" ? 0 : parseFloat(v) || 0);
  const hex = (c: string): string | undefined => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return undefined;
    const [r, g, b, a = "1"] = m[1]!.split(/[,\s/]+/).filter(Boolean);
    if (parseFloat(a) === 0) return undefined;
    const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
    return `#${h(+r!)}${h(+g!)}${h(+b!)}${parseFloat(a) < 1 ? h(parseFloat(a) * 255) : ""}`;
  };
  const tok = <T>(value: T, token?: string): Tokened<T> => (token ? { value, token } : { value });

  const moduleOf = (el: Element) => {
    for (const c of Array.from(el.classList)) {
      const m = /^([A-Za-z0-9]+)-module__[\w-]+$/.exec(c);
      if (m) return m[1]!;
    }
    return undefined;
  };
  const rootModule = moduleOf(root);
  // Layer names: an explicit data-cdf name first, then the CSS-module class; otherwise the tag, flagged
  // as unnamed so `codesignflo name` can give it a semantic name in code.
  const named = (el: Element): string | undefined => {
    const explicit = el.getAttribute("data-cdf") ?? el.getAttribute("data-cdl");
    if (explicit) return explicit;
    for (const c of Array.from(el.classList)) {
      const m = /^[A-Za-z0-9]+-module__([\w-]+)$/.exec(c);
      if (m) return m[1]!;
    }
    return undefined;
  };
  const nameOf = (el: Element, fallback: string) => named(el) ?? fallback;
  /** The box that lays the element out: wrappers with display: contents have no box of their own. */
  const layoutParent = (el: HTMLElement): HTMLElement | null => {
    let p = el.parentElement;
    while (p && p !== container && getComputedStyle(p).display === "contents") p = p.parentElement;
    return p;
  };
  /** Child nodes as laid out: the children of display: contents wrappers take their place. */
  const flowNodes = (el: Element): ChildNode[] =>
    Array.from(el.childNodes).flatMap((n) =>
      n.nodeType === Node.ELEMENT_NODE && getComputedStyle(n as Element).display === "contents" ? flowNodes(n as Element) : [n],
    );
  /** Grows along its flex parent's main axis (flex: 1), which the width probe misses inside a fixed-size parent. */
  const grows = (el: HTMLElement, dir: "row" | "column") => {
    // The root too: a story can give its container a size the component grows into (flex: 1).
    const p = layoutParent(el);
    if (!p) return false;
    const pcs = getComputedStyle(p);
    const flex = pcs.display === "flex" || pcs.display === "inline-flex";
    return flex && pcs.flexDirection.startsWith(dir) && parseFloat(getComputedStyle(el).flexGrow) > 0;
  };
  /**
   * A native checkbox or radio button as Chrome draws it, as SVG. Disabled ones in Chrome's own greys (an
   * opacity on the SVG is lost when Figma imports it).
   */
  const nativeControl = (el: HTMLInputElement, cs: CSSStyleDeclaration, w: number, h: number) => {
    const off = el.disabled;
    const accent = off ? "#d1d1d1" : (cs.accentColor !== "auto" && hex(cs.accentColor)) || "#0075ff";
    const tick = off ? "#ededed" : "#ffffff";
    const edge = off ? "#c5c5c5" : "#767676";
    const on = el.checked || el.indeterminate;
    let shape: string;
    if (el.type === "radio") {
      const r = Math.min(w, h) / 2;
      shape = on
        ? `<circle cx="${w / 2}" cy="${h / 2}" r="${r - 0.75}" fill="#ffffff" stroke="${accent}" stroke-width="1.5"/><circle cx="${w / 2}" cy="${h / 2}" r="${r * 0.5}" fill="${accent}"/>`
        : `<circle cx="${w / 2}" cy="${h / 2}" r="${r - 0.5}" fill="#ffffff" stroke="${edge}" stroke-width="1"/>`;
    } else if (on) {
      const mark = el.indeterminate
        ? `<path d="M${w * 0.25} ${h / 2}H${w * 0.75}" stroke="${tick}" stroke-width="${Math.max(1.5, w / 8)}" stroke-linecap="round"/>`
        : `<path d="M${w * 0.22} ${h * 0.52}L${w * 0.42} ${h * 0.72}L${w * 0.78} ${h * 0.3}" fill="none" stroke="${tick}" stroke-width="${Math.max(1.5, w / 8)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      shape = `<rect width="${w}" height="${h}" rx="2" fill="${accent}"/>${mark}`;
    } else shape = `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="#ffffff" stroke="${edge}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${shape}</svg>`;
  };
  const sizingW = (el: HTMLElement): Sizing => {
    if (Math.abs((wB.get(el) ?? 0) - (wA.get(el) ?? 0)) > 0.5) return "fill";
    // A width of its own: pixels, or font/viewport units and calc() (Tailwind's w-10 is 2.5rem).
    const w = declared(el, "width");
    if (/^\d+(\.\d+)?px$/.test(w) || /^-?[\d.]+(rem|em|vw|ch)$|^calc\(/.test(w)) return "fixed";
    // Table cells and rows: the table's layout gives them their widths.
    if (/^table-(cell|row|header-group|row-group|footer-group|column)$/.test(getComputedStyle(el).display)) return "fixed";
    // As wide as its content (Tailwind's w-fit): not stretched across its column.
    if (/^(fit-content|max-content|min-content)$/.test(w)) return "hug";
    // A max-width that caps the element (a chat bubble) is its width: its text wraps inside it (M6). Computed
    // values: px whatever unit the CSS used. Before "grows": a flex: 1 column held at its max-width (a settings
    // form, 880px beside a sidebar) filled the whole row in Figma, 952px of form instead of 800.
    const ecs = getComputedStyle(el);
    const width = el.getBoundingClientRect().width;
    if (/px$/.test(ecs.maxWidth) && Math.abs(width - parseFloat(ecs.maxWidth)) < 0.5) return "fixed";
    if (grows(el, "row")) return "fill";
    // A min-width that holds the element wider than its content is its width (a centred quantity).
    if (/px$/.test(ecs.minWidth) && parseFloat(ecs.minWidth) > 0 && Math.abs(width - parseFloat(ecs.minWidth)) < 0.5) return "fixed";
    // A flex item with a set basis that doesn't grow (basis-[360px], flex: 0 0 360px) is that wide.
    const lp = layoutParent(el);
    const lpcs = lp ? getComputedStyle(lp) : null;
    if (
      lpcs &&
      /flex/.test(lpcs.display) &&
      lpcs.flexDirection.startsWith("row") &&
      /px$/.test(ecs.flexBasis) &&
      parseFloat(ecs.flexGrow) === 0
    )
      return "fixed";
    // A share of the parent's width (after the caps above): all of it fills (Tailwind's w-full), a part of it
    // is the width it has.
    if (/^100(\.0+)?%$/.test(w)) return "fill";
    if (/%$/.test(w)) return "fixed";
    // Stretched across a column (align-items: stretch / normal) fills it even inside a fixed-width parent,
    // where widening the page changes nothing (cart summary rows).
    const p = layoutParent(el);
    if (p && el !== root) {
      const pcs = getComputedStyle(p);
      const ecs = getComputedStyle(el);
      const own = ecs.alignSelf;
      const self = own === "auto" ? pcs.alignItems : own;
      const column = (pcs.display === "flex" || pcs.display === "inline-flex") && pcs.flexDirection.startsWith("column");
      if (column && (self === "normal" || self === "stretch")) return "fill";
      // A grid cell's content stretches across its column unless justify-self says otherwise.
      const justifySelf = ecs.justifySelf === "auto" ? pcs.justifyItems : ecs.justifySelf;
      if ((pcs.display === "grid" || pcs.display === "inline-grid") && /^(normal|stretch|legacy)$/.test(justifySelf)) return "fill";
      // A block box in normal flow takes its container's whole width (a heading in a block wrapper).
      const flowParent = !/flex|grid|inline|table/.test(pcs.display);
      const blockBox = ["block", "flex", "grid", "flow-root", "list-item"].includes(ecs.display);
      const auto = !declared(el, "width") || declared(el, "width") === "auto";
      if (flowParent && blockBox && auto && ecs.float === "none" && ecs.position !== "absolute" && ecs.position !== "fixed") return "fill";
    }
    return "hug";
  };
  /** Its content is taller (y) or wider (x) than the box, which hides the rest (overflow other than visible). */
  const cutsOff = (el: HTMLElement, axis: "x" | "y") => {
    const ecs = getComputedStyle(el);
    if ((axis === "y" ? ecs.overflowY : ecs.overflowX) === "visible") return false;
    return axis === "y" ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
  };
  const sizingH = (el: HTMLElement): Sizing => {
    const h = declared(el, "height");
    if (/^\d+(\.\d+)?px$/.test(h)) return "fixed";
    // Showing part of its content (a list capped by max-height that scrolls): its height is what it shows,
    // not its content's (which Figma would grow to, spilling the hidden rows over what follows).
    if (cutsOff(el, "y")) return "fixed";
    // Viewport and font units, calc(): a height of its own, as rendered (a 100vh sidebar).
    if (/^-?[\d.]+(vh|dvh|svh|lvh|rem|em)$|^calc\(/.test(h)) return "fixed";
    // A share of its grid cell (h-full in a grid) is the row's height, which its content sets: as tall as it is.
    // Filling, Figma squeezed a scrolling grid's rows to fit its height (four 78px rows drawn 62px tall).
    const lp = layoutParent(el);
    if (/%$/.test(h) && lp && /grid/.test(getComputedStyle(lp).display)) return "fixed";
    if (/%$/.test(h)) return el === root ? "fixed" : "fill";
    if (grows(el, "column")) return "fill";
    // A min-height that holds the element taller than its content is its height.
    const minH = getComputedStyle(el).minHeight;
    if (/px$/.test(minH) && parseFloat(minH) > 0 && Math.abs(el.getBoundingClientRect().height - parseFloat(minH)) < 0.5) return "fixed";
    // The story's wrapper sets the root's height (stretched taller, or holding content that overflows it):
    // its height comes from outside, keep it as rendered.
    if (el === root && Math.abs(naturalHeight(el) - el.getBoundingClientRect().height) > 0.5) return "fixed";
    // Stretched on the cross axis: grid cells (default) and children of a flex row with align-items stretch.
    const p = layoutParent(el);
    if (p && el !== root) {
      const pcs = getComputedStyle(p);
      const own = getComputedStyle(el).alignSelf;
      const self = own === "auto" ? pcs.alignItems : own;
      const stretched = self === "normal" || self === "stretch";
      const grid = pcs.display === "grid" || pcs.display === "inline-grid";
      const flexRow = (pcs.display === "flex" || pcs.display === "inline-flex") && pcs.flexDirection.startsWith("row");
      // Not in a grid that scrolls: Figma shares its capped height between the rows and squeezed them (a dialog's
      // list of 56px rows drawn without its gaps, one row more showing than in the browser).
      if (stretched && grid && cutsOff(p, "y")) return "fixed";
      if (stretched && (grid || flexRow)) return "fill";
    }
    return "hug";
  };
  /** Height without being stretched by its parent (align-self: flex-start), measured and restored. */
  const naturalHeight = (el: HTMLElement) => {
    const prev = el.style.alignSelf;
    el.style.alignSelf = "flex-start";
    const h = el.getBoundingClientRect().height;
    el.style.alignSelf = prev;
    return h;
  };
  // Every way the browser may spell a position: Chrome 158 reports justify-content: flex-end as "flow-end" (read
  // as the start, a drawer on the right was drawn on the left); "safe"/"unsafe" prefixes don't move anything.
  const position = (v: string) => {
    const x = v.replace(/^(safe|unsafe)\s+/, "").trim();
    return /^(flex-end|end|flow-end|self-end|right|last baseline)$/.test(x) ? "end" : x;
  };
  const align = (v: string): NonNullable<IRNode["layout"]>["align"] => {
    const x = position(v);
    return x === "center"
      ? "CENTER"
      : x === "end"
        ? "MAX"
        : /baseline/.test(x)
          ? "BASELINE"
          : x === "normal" || x === "stretch"
            ? "STRETCH"
            : "MIN";
  };
  const justify = (v: string): NonNullable<IRNode["layout"]>["justify"] => {
    const x = position(v);
    return x === "center" ? "CENTER" : x === "end" ? "MAX" : x === "space-between" ? "SPACE_BETWEEN" : "MIN";
  };

  /** The picture as shown (object-fit cover/contain/fill applied) as PNG at 2×; nothing if unreadable. */
  const rasterize = (img: HTMLImageElement, cs: CSSStyleDeclaration): { image?: { png: string } } => {
    const r = img.getBoundingClientRect();
    if (!img.complete || !img.naturalWidth || r.width < 1 || r.height < 1) return {};
    try {
      const scale = 2;
      const c = document.createElement("canvas");
      c.width = Math.round(r.width * scale);
      c.height = Math.round(r.height * scale);
      const ctx = c.getContext("2d")!;
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const fit = cs.objectFit;
      let dw = c.width;
      let dh = c.height;
      if (fit === "cover" || fit === "contain") {
        const k = (fit === "cover" ? Math.max : Math.min)(c.width / iw, c.height / ih);
        dw = iw * k;
        dh = ih * k;
      }
      ctx.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
      return { image: { png: c.toDataURL("image/png").split(",")[1]! } };
    } catch {
      return {}; // cross-origin picture: keep the placeholder
    }
  };
  /** Height of one rendered line of the element's own text (its line box with line-height: normal). */
  const renderedLineHeight = (el: HTMLElement): number => {
    const range = document.createRange();
    const node = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
    if (!node) return 0;
    range.selectNodeContents(node);
    const first = range.getClientRects()[0];
    return first ? Math.round(first.height * 100) / 100 : 0;
  };
  /** The element's content box (inside padding and border): where its own text sits. */
  const contentBox = (el: HTMLElement, cs: CSSStyleDeclaration) => {
    const r = el.getBoundingClientRect();
    const x = px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
    const y = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    return { w: round(Math.max(0, r.width - x)), h: round(Math.max(0, r.height - y)) };
  };
  const textOf = (el: HTMLElement, cs: CSSStyleDeclaration, characters: string): NonNullable<IRNode["text"]> => {
    const clamp = parseInt(cs.getPropertyValue("-webkit-line-clamp"), 10);
    const tt = cs.textTransform;
    const textCase = tt === "uppercase" ? "UPPER" : tt === "lowercase" ? "LOWER" : tt === "capitalize" ? "TITLE" : undefined;
    // One line cut with "…" (white-space: nowrap + text-overflow: ellipsis) is a one-line truncation.
    const ellipsis = cs.textOverflow === "ellipsis" && cs.whiteSpace.startsWith("nowrap") ? 1 : 0;
    const ta = cs.textAlign;
    const align = ta === "center" ? "CENTER" : ta === "right" || ta === "end" ? "RIGHT" : ta === "justify" ? "JUSTIFIED" : undefined;
    return {
      characters,
      fontFamily: familyOf(cs),
      fontWeight: tok(parseInt(cs.fontWeight, 10), tokenIn(declaredUp(el, "font-weight"))),
      fontSize: tok(px(cs.fontSize), tokenIn(declaredUp(el, "font-size"))),
      // "normal" depends on the font's metrics and differs between the browser and Figma's "auto":
      // use the line height the browser actually rendered.
      lineHeight: cs.lineHeight === "normal" ? renderedLineHeight(el) : px(cs.lineHeight),
      letterSpacing: px(cs.letterSpacing),
      color: tok(hex(cs.color) ?? "#000000", tokenIn(declaredUp(el, "color"))),
      ...(clamp > 0 ? { maxLines: clamp } : ellipsis ? { maxLines: 1 } : {}),
      ...(align ? { align } : {}),
      ...(textCase ? { case: textCase } : {}),
      ...(cs.fontStyle === "italic" || cs.fontStyle.startsWith("oblique") ? { italic: true as const } : {}),
    };
  };
  /**
   * The font the text asks for: the first named family, past CSS's generic names ("ui-monospace, SFMono-Regular,
   * Menlo" is SFMono-Regular; read as "ui-monospace", Figma had no such font and drew code in Inter).
   */
  const GENERIC =
    /^(ui-monospace|ui-sans-serif|ui-serif|ui-rounded|system-ui|-apple-system|BlinkMacSystemFont|monospace|sans-serif|serif|cursive|fantasy|math|emoji)$/i;
  const familyOf = (ecs: CSSStyleDeclaration) => {
    const names = ecs.fontFamily.split(",").map((f) => f.replace(/["']/g, "").trim());
    return names.find((f) => f && !GENERIC.test(f)) ?? (/mono/i.test(names[0] ?? "") ? "SF Mono" : names[0]!);
  };
  /**
   * A paragraph whose words flow across inline parts (a bold email, a link, a line break) as one text with
   * styled runs, as the browser flows it. As separate layers Figma stacked or squeezed them ("marta@…" split
   * over two lines, "is on the list." on its own line). Only plain inline text: an inline part with a box of
   * its own (a pill, a badge), a picture or a field keeps the layers.
   */
  const paragraph = (el: HTMLElement, ecs: CSSStyleDeclaration, kids: HTMLElement[]) => {
    if (!kids.length || /flex|grid|table/.test(ecs.display) || /^(pre|break-spaces|pre-wrap)/.test(ecs.whiteSpace)) return null;
    const plain = (e: HTMLElement): boolean => {
      const k = getComputedStyle(e);
      if (e.tagName === "BR") return true;
      if (k.display !== "inline" || k.position !== "static" || /^(IMG|SVG|INPUT|SELECT|TEXTAREA|BUTTON|svg)$/.test(e.tagName)) return false;
      if (hex(k.backgroundColor) || px(k.paddingLeft) + px(k.paddingRight) + px(k.borderLeftWidth) + px(k.borderBottomWidth) > 0)
        return false;
      return Array.from(e.children).every((c) => getComputedStyle(c).display === "none" || plain(c as HTMLElement));
    };
    if (!kids.every(plain)) return null;
    // A paragraph has words of its own around the parts (a wrapper holding one <code> or <span> isn't one), and
    // parts the code names (data-cdf) stay layers of their own.
    if (!Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) return null;
    if (kids.some((k) => k.matches("[data-cdf], [data-cdl]") || k.querySelector("[data-cdf], [data-cdl]"))) return null;
    // Characters and whose style each has; white space collapses across the parts as the browser does.
    let out = "";
    const owner: HTMLElement[] = [];
    // One owner per UTF-16 unit, as the runs index the text: an emoji ("👋") is two (it used to shift every
    // character after it by one, and the last one had no owner).
    const push = (ch: string, o: HTMLElement) => {
      out += ch;
      for (let i = 0; i < ch.length; i++) owner.push(o);
    };
    const visit = (node: Node, o: HTMLElement) => {
      for (const c of Array.from(node.childNodes)) {
        if (c.nodeType === Node.TEXT_NODE) {
          for (const ch of c.textContent!) {
            if (/\s/.test(ch)) {
              if (out && !/[ \n]$/.test(out)) push(" ", o);
            } else push(ch, o);
          }
        } else if (c.nodeType === Node.ELEMENT_NODE) {
          const e = c as HTMLElement;
          if (e.tagName === "BR") {
            if (out.endsWith(" ")) {
              out = out.slice(0, -1);
              owner.pop();
            }
            push("\n", o);
          } else if (getComputedStyle(e).display !== "none" && !screenReaderOnly(e)) visit(e, e);
        }
      }
    };
    visit(el, el);
    while (out.endsWith(" ")) {
      out = out.slice(0, -1);
      owner.pop();
    }
    if (!out.trim()) return null;
    const look = (o: HTMLElement) => {
      const k = getComputedStyle(o);
      return {
        fontFamily: familyOf(k),
        fontWeight: parseInt(k.fontWeight, 10),
        italic: k.fontStyle === "italic" || k.fontStyle.startsWith("oblique"),
        fontSize: px(k.fontSize),
        color: hex(k.color) ?? "#000000",
        underline: k.textDecorationLine.includes("underline"),
      };
    };
    const base = look(el);
    const runs: NonNullable<NonNullable<IRNode["text"]>["runs"]> = [];
    let i = 0;
    while (i < out.length) {
      const o = owner[i]!;
      let j = i + 1;
      while (j < out.length && owner[j] === o) j++;
      if (o !== el) {
        const l = look(o);
        const diff = Object.fromEntries(
          (Object.keys(l) as (keyof typeof l)[]).filter((key) => l[key] !== base[key]).map((key) => [key, l[key]]),
        );
        if (Object.keys(diff).length) {
          const prev = runs[runs.length - 1];
          if (prev && prev.end === i && JSON.stringify({ ...prev, start: 0, end: 0 }) === JSON.stringify({ ...diff, start: 0, end: 0 }))
            prev.end = j;
          else runs.push({ start: i, end: j, ...diff });
        }
      }
      i = j;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = new Set(
      Array.from(range.getClientRects())
        .filter((r) => r.width > 0)
        .map((r) => Math.round(r.bottom)),
    ).size;
    const mark = markerOf(el, ecs);
    const text = textOf(el, ecs, mark + out);
    if (runs.length) text.runs = runs.map((r) => ({ ...r, start: r.start + mark.length, end: r.end + mark.length }));
    return { text, range, lines: Math.max(1, lines) };
  };

  /**
   * A computed linear-gradient ("linear-gradient(120deg, rgb(…), rgb(…) 55%, rgb(…))") → angle and stops,
   * each with its token when the declared CSS used var() for it (in the same order).
   */
  const linearGradient = (computed: string, decl: string): IRNode["gradient"] | undefined => {
    const g = /linear-gradient\((.*)\)\s*$/.exec(computed.trim());
    if (!g || computed.indexOf("gradient(") !== computed.lastIndexOf("gradient(")) return undefined;
    const parts = g[1]!.split(/,(?![^(]*\))/).map((x) => x.trim());
    let angle = 180;
    const dirs: Record<string, number> = {
      top: 0,
      right: 90,
      bottom: 180,
      left: 270,
      "top right": 45,
      "right top": 45,
      "bottom right": 135,
      "right bottom": 135,
      "bottom left": 225,
      "left bottom": 225,
      "top left": 315,
      "left top": 315,
    };
    if (/deg$|turn$|rad$/.test(parts[0]!)) {
      const v = parseFloat(parts[0]!);
      angle = parts[0]!.endsWith("turn") ? v * 360 : parts[0]!.endsWith("rad") ? (v * 180) / Math.PI : v;
      parts.shift();
    } else if (parts[0]!.startsWith("to ")) {
      angle = dirs[parts.shift()!.slice(3)] ?? 180;
    }
    const tokens = [...decl.matchAll(/var\(--([\w-]+)\)/g)].map((x) => x[1]!);
    const stops = parts.flatMap((p) => {
      const color = hex(/rgba?\([^)]+\)/.exec(p)?.[0] ?? "");
      if (!color) return [];
      const pos = /(-?[\d.]+)%\s*$/.exec(p);
      return [{ color, position: pos ? parseFloat(pos[1]!) / 100 : Number.NaN }];
    });
    if (stops.length < 2) return undefined;
    // Stops without a position spread evenly between their neighbours (CSS).
    if (Number.isNaN(stops[0]!.position)) stops[0]!.position = 0;
    if (Number.isNaN(stops[stops.length - 1]!.position)) stops[stops.length - 1]!.position = 1;
    for (let i = 1; i < stops.length - 1; i++)
      if (Number.isNaN(stops[i]!.position)) {
        let j = i;
        while (Number.isNaN(stops[j]!.position)) j++;
        const a = stops[i - 1]!.position;
        const b = stops[j]!.position;
        for (let x = i; x < j; x++) stops[x]!.position = a + ((b - a) * (x - i + 1)) / (j - i + 1);
      }
    const named = tokens.length === stops.length;
    return {
      angle: Math.round(angle * 100) / 100,
      stops: stops.map((s, i) => ({ color: tok(s.color, named ? tokens[i] : undefined), position: Math.round(s.position * 1000) / 1000 })),
    };
  };
  /** Text as the browser shows it: spaces collapse, line breaks stay where white-space keeps them (pre-line). */
  const shownText = (raw: string, ws: string) =>
    /^(pre|break-spaces)/.test(ws)
      ? raw.replace(/^\n|\n$/g, "")
      : ws === "pre-line"
        ? raw
            .split("\n")
            .map((l) => l.replace(/[ \t\f\r]+/g, " ").trim())
            .join("\n")
            .trim()
        : raw.replace(/\s+/g, " ").trim();
  /** A table cell's vertical-align as a Figma alignment (middle and the default baseline-ish values: centre). */
  const cellAlign = (c: Element | undefined): "MIN" | "CENTER" | "MAX" => {
    const va = c ? getComputedStyle(c).verticalAlign : "middle";
    return va === "top" ? "MIN" : va === "bottom" ? "MAX" : "CENTER";
  };
  /** Positioned children's z-index (auto: 0), for the order they're drawn in. */
  const zOf = new WeakMap<IRNode, number>();
  /**
   * Children in the order the browser paints them: a layer placed out of the flow (absolute) is drawn over the
   * content around it, by z-index, wherever it is in the code; one with a negative z-index under it. Figma draws
   * in layer order, so a "Show preview" button that came first was hidden under the white panel after it.
   */
  const paintOrder = (kids: IRNode[]): IRNode[] => {
    const placed = (c: IRNode) => !!c.absolute;
    const z = (c: IRNode) => zOf.get(c) ?? 0;
    const below = kids.filter((c) => placed(c) && z(c) < 0).sort((a, b) => z(a) - z(b));
    const above = kids.filter((c) => placed(c) && z(c) >= 0).sort((a, b) => z(a) - z(b));
    return [...below, ...kids.filter((c) => !placed(c)), ...above];
  };
  /** Its in-flow items sit on more than one line. */
  const wrapsNow = (kids: HTMLElement[]) => {
    const boxes = kids
      .filter((k) => !/absolute|fixed/.test(getComputedStyle(k).position))
      .map((k) => before.get(k) ?? k.getBoundingClientRect());
    // Below the first line: starting under the first item (items of a line differ in height, not in line).
    return boxes.some((b) => b.top >= boxes[0]!.bottom - 0.5);
  };
  /** A ::before / ::after drawn as a box (absolutely placed, with a background or border), else nothing. */
  const pseudoBox = (el: HTMLElement, ecs: CSSStyleDeclaration, which: "::before" | "::after"): IRNode | null => {
    const p = getComputedStyle(el, which);
    if (p.content === "none" || p.content === "normal" || p.display === "none") return null;
    if (p.content.replace(/["']/g, "").trim()) return null;
    if (p.position !== "absolute" || p.visibility === "hidden" || parseFloat(p.opacity) === 0) return null;
    const m = /^matrix\(([^)]+)\)/.exec(p.transform);
    if (m) {
      const [a, b, c, d] = m[1]!.split(",").map(Number);
      if (Math.hypot(a!, b!) < 0.01 || Math.hypot(c!, d!) < 0.01) return null;
    }
    const w = px(p.width);
    const h = px(p.height);
    const fill = hex(p.backgroundColor);
    const bw = p.borderTopStyle === "none" ? 0 : px(p.borderTopWidth);
    if (w <= 0 || h <= 0 || (!fill && !bw)) return null;
    // Offsets are from the padding box; Figma places from the frame's outer edge (its border included).
    const r = before.get(el) ?? el.getBoundingClientRect();
    const inner = {
      w: r.width - px(ecs.borderLeftWidth) - px(ecs.borderRightWidth),
      h: r.height - px(ecs.borderTopWidth) - px(ecs.borderBottomWidth),
    };
    const x = px(ecs.borderLeftWidth) + (p.left !== "auto" ? px(p.left) : inner.w - px(p.right) - w);
    const y = px(ecs.borderTopWidth) + (p.top !== "auto" ? px(p.top) : inner.h - px(p.bottom) - h);
    const radius = px(p.borderTopLeftRadius);
    const zero = tok(0);
    return {
      name: which === "::before" ? "before" : "after",
      type: "FRAME",
      width: round(w),
      height: round(h),
      sizing: { w: "fixed", h: "fixed" },
      // Every frame has a layout (the compiler sets Figma's from it; without one it crashed).
      layout: { direction: "VERTICAL", gap: zero, padding: [zero, zero, zero, zero], align: "MIN", justify: "MIN" },
      absolute: { x: round(x), y: round(y) },
      ...(fill ? { fill: tok(fill, tokenIn(p.getPropertyValue("background-color"))) } : {}),
      ...(bw ? { stroke: { color: tok(hex(p.borderTopColor) ?? "#00000000"), width: bw } } : {}),
      ...(radius ? { radius: tok(radius) } : {}),
      at: { x: round(r.left - rootBox.left + x), y: round(r.top - rootBox.top + y) },
    };
  };
  /**
   * A list item's marker as the browser draws it ("• ", "1. "), put before its text: Chrome draws it outside the
   * text, so it isn't in the page (Live showed a recipe's ingredients and steps without bullets or numbers).
   */
  const markerOf = (el: HTMLElement, ecs: CSSStyleDeclaration): string => {
    if (ecs.display !== "list-item" || ecs.listStyleType === "none" || ecs.listStyleImage !== "none") return "";
    const t = ecs.listStyleType;
    const bullet: Record<string, string> = { disc: "•", circle: "◦", square: "▪" };
    if (bullet[t]) return `${bullet[t]} `;
    const list = el.parentElement;
    const items = list ? Array.from(list.children).filter((c) => getComputedStyle(c).display === "list-item") : [el];
    const ol = list instanceof HTMLOListElement ? list : null;
    const i = items.indexOf(el);
    const own = el instanceof HTMLLIElement && el.value > 0 ? el.value : 0;
    const n = own || (ol?.reversed ? (ol.hasAttribute("start") ? ol.start : items.length) - i : (ol?.start ?? 1) + i);
    const letters = (k: number) => {
      let out = "";
      for (let x = k; x > 0; x = Math.floor((x - 1) / 26)) out = String.fromCharCode(97 + ((x - 1) % 26)) + out;
      return out;
    };
    const roman = (k: number) => {
      const r: [number, string][] = [
        [1000, "m"],
        [900, "cm"],
        [500, "d"],
        [400, "cd"],
        [100, "c"],
        [90, "xc"],
        [50, "l"],
        [40, "xl"],
        [10, "x"],
        [9, "ix"],
        [5, "v"],
        [4, "iv"],
        [1, "i"],
      ];
      let out = "";
      let x = k;
      for (const [v, s] of r)
        while (x >= v) {
          out += s;
          x -= v;
        }
      return out;
    };
    const label = /alpha|latin/.test(t) ? letters(n) : /roman/.test(t) ? roman(n) : String(n);
    return `${/^upper/.test(t) ? label.toUpperCase() : label}. `;
  };
  /** Fields Chrome draws with a calendar button. */
  const PICKERS = new Set(["date", "datetime-local", "month", "week"]);
  /**
   * A date field's value as Chrome shows it: in the browser's language (03.12.2025, 12/03/2025), not as the
   * value it holds (2025-12-03), which Live showed.
   */
  const picked = (type: string, v: string): string => {
    if (!v || !PICKERS.has(type) || type === "week") return v;
    const d = new Date(type === "month" ? `${v}-01T00:00` : type === "date" ? `${v}T00:00` : v);
    if (Number.isNaN(d.getTime())) return v;
    const opts: Intl.DateTimeFormatOptions =
      type === "month" ? { year: "numeric", month: "long" } : { year: "numeric", month: "2-digit", day: "2-digit" };
    if (type === "datetime-local") Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
    return new Intl.DateTimeFormat(navigator.language, opts).format(d).replace(/,(?= \d)/, "");
  };
  /** Laid out as a block, as wide as its column (not inline, not a flex or grid item's own content box). */
  const blockLevel = (ecs: CSSStyleDeclaration) => ["block", "flow-root", "list-item"].includes(ecs.display);
  /**
   * A block as wide as its column, in normal flow. Not a flex or grid item: those are as wide as their content
   * (a button centres its text by default, and every link in a row of them was stretched to share it).
   */
  const blockInFlow = (el: HTMLElement, ecs: CSSStyleDeclaration) => {
    const p = layoutParent(el);
    return blockLevel(ecs) && !(p && /flex|grid/.test(getComputedStyle(p).display));
  };
  /** A margin set to auto on that side (ml-auto, mx-auto): in a flex box it takes the room that's left. */
  const autoMargin = (el: HTMLElement, side: "left" | "right" | "top" | "bottom") => {
    const inline =
      side === "left"
        ? "margin-inline-start"
        : side === "right"
          ? "margin-inline-end"
          : side === "top"
            ? "margin-block-start"
            : "margin-block-end";
    const both = side === "left" || side === "right" ? "margin-inline" : "margin-block";
    return [`margin-${side}`, inline, both].some((p) => declared(el, p) === "auto");
  };
  /**
   * Child nodes with neighbouring text nodes as one run of text: React writes {pct}% as two text nodes ("62",
   * "%") the browser shows as "62%" (as two layers, Live put a gap between them). Runs with only white space
   * are left out.
   */
  type Run = { raw: string; range: () => Range };
  const runsOf = (nodes: ChildNode[]): (ChildNode | Run)[] => {
    const out: (ChildNode | Run)[] = [];
    let texts: ChildNode[] = [];
    const flush = () => {
      const raw = texts.map((t) => t.textContent!).join("");
      if (raw.trim()) {
        const [first, last] = [texts[0]!, texts[texts.length - 1]!];
        out.push({
          raw,
          range: () => {
            const r = document.createRange();
            r.setStartBefore(first);
            r.setEndAfter(last);
            return r;
          },
        });
      }
      texts = [];
    };
    for (const n of nodes) {
      if (n.nodeType === Node.TEXT_NODE) texts.push(n);
      else {
        flush();
        out.push(n);
      }
    }
    flush();
    return out;
  };
  /** Where a box is on the page: from the story root's top-left (as rendered, before the width probe). */
  const rootBox = before.get(root) ?? root.getBoundingClientRect();
  const place = (r: DOMRect | { left: number; top: number }) => ({ x: round(r.left - rootBox.left), y: round(r.top - rootBox.top) });
  /**
   * Text for screen readers only ("sr-only": a 1×1 box that clips): nothing shows. Drawn, it was a 1px-wide
   * text box whose letters ran down the page one per line.
   */
  const screenReaderOnly = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    if (r.width > 1 || r.height > 1) return false;
    const cs = getComputedStyle(el);
    return cs.overflow !== "visible" || (cs.clip !== "auto" && cs.clip !== "") || cs.clipPath !== "none";
  };
  /**
   * Drawn above the rest of the page, not only inside its parent: fixed to the window, or an absolute layer
   * raised with z-index that reaches out of its parent (a dropdown or date picker opening over the cards below)
   * with nothing above it clipping it. Figma draws later layers on top, so left in its parent it was hidden
   * under what follows (Live: a date range popup behind the KPI cards, its Apply button a sliver).
   */
  const onTop = (el: HTMLElement): boolean => {
    if (el === container || el === root || !el.parentElement) return false;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed") return true;
    if (cs.position !== "absolute" || !(parseInt(cs.zIndex, 10) > 0)) return false;
    const r = before.get(el) ?? el.getBoundingClientRect();
    const p = before.get(el.parentElement) ?? el.parentElement.getBoundingClientRect();
    const sticksOut = r.left < p.left - 1 || r.top < p.top - 1 || r.right > p.right + 1 || r.bottom > p.bottom + 1;
    if (!sticksOut) return false;
    for (let a = el.parentElement as HTMLElement | null; a && a !== container; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflowX !== "visible" || acs.overflowY !== "visible") return false;
    }
    return true;
  };
  const walk = (el: HTMLElement): IRNode => {
    const cs = getComputedStyle(el);
    const rect = before.get(el) ?? el.getBoundingClientRect();
    // Out of the flow (overlays, scrims, corner badges): where it sits in its parent, at the size it has.
    const parent = el.parentElement;
    const out = (cs.position === "absolute" || cs.position === "fixed") && parent && el !== container && el !== root;
    // Drawn on top (fixed to the window, or raised over what follows): placed on the page itself (lifted out
    // of its parent below), not in the parent, which would clip it, shift it (a drawer on the right drawn at
    // the left, a backdrop cut short) or draw later layers over it.
    const lifted = out && onTop(el);
    const pr = out ? (lifted ? rootBox : (before.get(parent!) ?? parent!.getBoundingClientRect())) : null;
    // Rotated (transform: rotate): its own size, not the rotated box's, and the angle.
    const m = /^matrix\(([^)]+)\)/.exec(cs.transform);
    const [ma, mb] = m ? m[1]!.split(",").map(Number) : [1, 0];
    const turned = m ? Math.round(((Math.atan2(mb!, ma!) * 180) / Math.PI) * 100) / 100 : 0;
    const rotated = Math.abs(turned) > 0.05 && el instanceof HTMLElement;
    const base = {
      name: nameOf(el, el.tagName.toLowerCase()),
      // SVG artwork has no role of its own (its container is named); everything else needs a name.
      ...(named(el) || el.tagName.toLowerCase() === "svg" ? {} : { unnamed: true as const }),
      width: round(rotated ? el.offsetWidth : rect.width),
      height: round(rotated ? el.offsetHeight : rect.height),
      sizing: out || rotated ? { w: "fixed" as const, h: "fixed" as const } : { w: sizingW(el), h: sizingH(el) },
      ...(rotated ? { rotation: turned } : {}),
      ...(pr ? { absolute: { x: round(rect.left - pr.left), y: round(rect.top - pr.top) } } : {}),
      ...(moduleOf(el) ? { module: moduleOf(el) } : {}),
      // Its classes (Tailwind's included): the compiler tells components apart by them where no CSS module does.
      ...(el.getAttribute("class")?.trim() ? { cls: [...new Set(el.getAttribute("class")!.trim().split(/\s+/))].sort().join(" ") } : {}),
      at: place(rect),
    };
    if (el.tagName === "IMG") return { ...base, type: "IMAGE", fill: tok("#e0e7ff"), ...rasterize(el as HTMLImageElement, cs) };
    // A native checkbox or radio button is drawn by the browser (no background or border to read): drawn
    // here as it looks, ticked in the accent colour when checked (Live showed them empty, ticks missing).
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && cs.appearance !== "none")
      return { ...base, type: "SVG", svg: nativeControl(el, cs, base.width, base.height) };
    if (el.tagName.toLowerCase() === "svg") {
      // At the size it's drawn: icons say width="1em" and are sized by CSS; Figma would import them at 16px
      // and stretch them, keeping the line width (a 176px icon drawn with 1px lines instead of 11px).
      const copy = el.cloneNode(true) as SVGSVGElement;
      copy.setAttribute("width", String(base.width));
      copy.setAttribute("height", String(base.height));
      if (!copy.getAttribute("viewBox")) {
        const w0 = parseFloat(el.getAttribute("width") ?? "");
        const h0 = parseFloat(el.getAttribute("height") ?? "");
        // No viewBox: its own drawing size (pixel width/height) is the coordinate system.
        if (w0 > 0 && h0 > 0 && !/em|%/.test(`${el.getAttribute("width")}${el.getAttribute("height")}`))
          copy.setAttribute("viewBox", `0 0 ${w0} ${h0}`);
      }
      const svg = copy.outerHTML.replace(/currentColor/g, hex(cs.color) ?? "#000000");
      return { ...base, type: "SVG", svg };
    }
    const flow = flowNodes(el);
    // Not drawn by the browser: display none, hidden, or fully transparent (a native radio kept for the keyboard
    // under a custom one, opacity 0: Live drew it as a loose circle beside every option).
    const shown = (c: Element) => {
      const k = getComputedStyle(c);
      return k.display !== "none" && k.visibility !== "hidden" && parseFloat(k.opacity) !== 0;
    };
    const elementKids = flow.filter(
      (c) => c.nodeType === Node.ELEMENT_NODE && shown(c as Element) && !screenReaderOnly(c as HTMLElement),
    ) as HTMLElement[];
    // The element's text as one run: React writes {pct}% as two text nodes ("62", "%"), shown as "62%"
    // (joined with a space, Live read "62 %", and the wider text was cut with "…" to the app's width).
    const ownText = shownText(
      flow
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent!)
        .join(""),
      cs.whiteSpace,
    );
    const hasBox = !!hex(cs.backgroundColor) || px(cs.borderTopWidth) > 0 || px(cs.paddingTop) + px(cs.paddingLeft) > 0;
    if (elementKids.length === 0 && ownText && !hasBox) {
      const text = textOf(el, cs, markerOf(el, cs) + ownText);
      // Text the browser wraps onto several lines, or cuts with "…", has a width it must keep in Figma:
      // it fills its column (M6: chat bubbles ran on one line, list previews wrapped instead of "…").
      const lineH = text.lineHeight || renderedLineHeight(el) || 1;
      const lines = Math.round(rect.height / lineH);
      // A one-line "…" text that fits isn't held to its column: in the app it's as wide as its words (a title
      // or a value next to its label); only one actually cut needs the column's width.
      const cut = el.scrollWidth > el.clientWidth + 1;
      // Centred (or right-aligned) in a block as wide as its column: the text is placed within that width,
      // which a box hugging its words loses (Live: "No conversations yet." at the left of its card).
      const placedInBlock = !!text.align && text.align !== "JUSTIFIED" && blockInFlow(el, cs);
      const constrained = lines > 1 || (text.maxLines ?? 0) > 1 || (text.maxLines === 1 && cut) || placedInBlock;
      const sizing = constrained && base.sizing.w === "hug" ? { ...base.sizing, w: "fill" as const } : base.sizing;
      return { ...base, sizing, name: nameOf(el, "text"), type: "TEXT", text };
    }
    const para = paragraph(el, cs, elementKids);
    if (para && !hasBox) {
      const placed = !!para.text.align && para.text.align !== "JUSTIFIED" && blockInFlow(el, cs);
      const sizing = (para.lines > 1 || placed) && base.sizing.w === "hug" ? { ...base.sizing, w: "fill" as const } : base.sizing;
      return { ...base, sizing, name: nameOf(el, "text"), type: "TEXT", text: para.text };
    }

    const node: IRNode = { ...base, type: "FRAME" };
    // An iframe: what it shows is read from its own page afterwards (extractPage), into this layer.
    if (el.tagName === "IFRAME") node.iframe = Array.from(document.querySelectorAll("iframe")).indexOf(el as HTMLIFrameElement);
    // Root element of another component module (e.g. Button inside ProductCard) → instance candidate. The
    // story's own root records its classes too: they tell a component's root from its inner parts.
    const mod = moduleOf(el);
    if (mod && (el === root || mod !== rootModule)) {
      node.component = {
        module: mod,
        classes: Array.from(el.classList)
          .map((c) => /-module__([\w-]+)$/.exec(c)?.[1])
          .filter((c): c is string => !!c)
          .sort(),
      };
    }
    const display = cs.display;
    const flex = display === "flex" || display === "inline-flex";
    /** A grid laid out as a row of its children's widths (see below): each keeps the width it has. */
    let spansAsRow = false;
    // A table row's cells sit side by side (a row of the table's columns), like a flex row.
    const row = (flex && cs.flexDirection.startsWith("row")) || display === "table-row";
    if (display === "grid" || display === "inline-grid") {
      const tracks = (v: string) => (v === "none" ? 0 : v.trim().split(/\s+/).length);
      const gapToken = tokenIn(declared(el, "gap"));
      node.layout = {
        direction: "GRID",
        columns: tracks(cs.gridTemplateColumns),
        ...(cs.gridTemplateColumns !== "none"
          ? {
              columnSizes: cs.gridTemplateColumns
                .trim()
                .split(/\s+/)
                .map((t) => round(px(t))),
            }
          : {}),
        rows: Math.max(1, tracks(cs.gridTemplateRows)),
        gap: tok(px(cs.columnGap), tokenIn(declared(el, "column-gap")) ?? gapToken),
        rowGap: tok(px(cs.rowGap), tokenIn(declared(el, "row-gap")) ?? gapToken),
        padding: [
          tok(px(cs.paddingTop), sideToken(el, "padding", 0, "padding-top")),
          tok(px(cs.paddingRight), sideToken(el, "padding", 1, "padding-right")),
          tok(px(cs.paddingBottom), sideToken(el, "padding", 2, "padding-bottom")),
          tok(px(cs.paddingLeft), sideToken(el, "padding", 3, "padding-left")),
        ],
        align: "STRETCH",
        justify: "MIN",
      };
      // Children spanning several columns (a 12-column grid with col-span-7 and col-span-5 panels): Figma
      // would put each in one 138px column — laid out as a row of the widths they have (rows wrapping).
      const cells = Array.from(el.children).filter((k) => {
        const kcs = getComputedStyle(k);
        return kcs.display !== "none" && kcs.position !== "absolute" && kcs.position !== "fixed";
      }) as HTMLElement[];
      const widest = Math.max(0, ...(node.layout.columnSizes ?? [0]));
      if ((node.layout.columns ?? 0) > 1 && cells.some((k) => k.getBoundingClientRect().width > widest + 1)) {
        const rowsOf = new Set(cells.map((k) => Math.round(k.getBoundingClientRect().top)));
        const { columns: _c, columnSizes: _s, rows: _r, ...rest } = node.layout;
        node.layout = { ...rest, direction: "HORIZONTAL", align: "STRETCH", ...(rowsOf.size > 1 ? { wrap: true as const } : {}) };
        spansAsRow = true;
      } else if ((node.layout.columns ?? 0) <= 1) {
        // One column: a stack, as Figma's grid would share the grid's height between its rows (a scrolling list
        // of 78px rows drawn 62px apart, overlapping, one row more showing than in the browser).
        const { columns: _c, columnSizes: _s, rows: _r, rowGap, gap, ...rest } = node.layout;
        node.layout = { ...rest, direction: "VERTICAL", gap: rowGap ?? gap, align: "STRETCH" };
      }
    } else
      node.layout = {
        direction: row ? "HORIZONTAL" : "VERTICAL",
        gap: tok(px(row ? cs.columnGap : cs.rowGap), tokenIn(declared(el, "gap")) ?? tokenIn(declared(el, row ? "column-gap" : "row-gap"))),
        padding: [
          tok(px(cs.paddingTop), sideToken(el, "padding", 0, "padding-top")),
          tok(px(cs.paddingRight), sideToken(el, "padding", 1, "padding-right")),
          tok(px(cs.paddingBottom), sideToken(el, "padding", 2, "padding-bottom")),
          tok(px(cs.paddingLeft), sideToken(el, "padding", 3, "padding-left")),
        ],
        // A table cell lines up its content by vertical-align (middle by default in a table): Live drew every
        // cell's content at the top of its row. (The row stretches its cells, which carry the row's borders.)
        align: flex ? align(cs.alignItems) : "STRETCH",
        justify: flex ? justify(cs.justifyContent) : display === "table-cell" ? cellAlign(el) : "MIN",
        // A row of cards that wraps onto more rows (flex-wrap), rows apart by the row gap.
        // Only when it does wrap: a row that fits on one line in the browser, wrapping in Figma, put its last
        // item on a line of its own for a fraction of a pixel of text (Live: "Delete" below the other actions).
        ...(row && cs.flexWrap.startsWith("wrap") && wrapsNow(elementKids)
          ? { wrap: true, rowGap: tok(px(cs.rowGap), tokenIn(declared(el, "row-gap")) ?? tokenIn(declared(el, "gap"))) }
          : {}),
      };
    const bg = hex(cs.backgroundColor);
    if (bg) node.fill = tok(bg, tokenIn(declared(el, "background")) ?? tokenIn(declared(el, "background-color")));
    const gradient = linearGradient(cs.backgroundImage, declared(el, "background") || declared(el, "background-image"));
    if (gradient) node.gradient = gradient;
    // Borders per side (CSS often uses only border-top / border-bottom).
    const side = (s: "Top" | "Right" | "Bottom" | "Left") =>
      cs.getPropertyValue(`border-${s.toLowerCase()}-style`) === "none" ? 0 : px(cs.getPropertyValue(`border-${s.toLowerCase()}-width`));
    const widths = [side("Top"), side("Right"), side("Bottom"), side("Left")] as [number, number, number, number];
    const bw = Math.max(...widths);
    if (bw > 0) {
      const sides = ["Top", "Right", "Bottom", "Left"] as const;
      const colorSide = sides[widths.indexOf(bw)]!;
      // A transparent border still takes space in the CSS box model; keep it as an invisible stroke.
      const bc = hex(cs.getPropertyValue(`border-${colorSide.toLowerCase()}-color`)) ?? "#00000000";
      const token =
        tokenIn(declared(el, "border-color")) ??
        tokenIn(declared(el, "border")) ??
        tokenIn(declared(el, `border-${colorSide.toLowerCase()}-color`)) ??
        tokenIn(declared(el, `border-${colorSide.toLowerCase()}`));
      // Dashed / dotted borders: dash and gap as the browser draws them (3 × width; dots one width apart).
      const style = cs.getPropertyValue(`border-${colorSide.toLowerCase()}-style`);
      const dash: [number, number] | undefined = style === "dashed" ? [bw * 3, bw * 3] : style === "dotted" ? [bw, bw] : undefined;
      node.stroke = {
        color: tok(bc, token),
        width: bw,
        ...(widths.some((w) => w !== bw) ? { sides: widths } : {}),
        ...(dash ? { dash } : {}),
      };
    }
    const radius = px(cs.borderTopLeftRadius);
    if (radius > 0) node.radius = tok(Math.min(radius, 9999), tokenIn(declared(el, "border-radius")));
    const opacity = parseFloat(cs.opacity);
    if (opacity < 1) node.opacity = opacity;
    // Clips what doesn't fit, as the browser does: hidden, and scrolling boxes (auto, scroll) too.
    if ([cs.overflowX, cs.overflowY].some((o) => o !== "visible")) node.clip = true;
    if (cs.boxShadow !== "none") node.shadow = cs.boxShadow;

    // Form fields show their value, or their placeholder in its own colour (M6: Live showed empty fields).
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const f = el as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement;
      const type = (f.getAttribute("type") ?? "text").toLowerCase();
      const value =
        tag === "SELECT" ? (f.selectedOptions[0]?.text ?? "") : type === "password" ? "•".repeat(f.value.length) : picked(type, f.value);
      const shown = value || f.placeholder || "";
      if (shown && !["checkbox", "radio", "range", "color", "file", "hidden", "submit", "button"].includes(type)) {
        const text = textOf(el, cs, shown);
        if (!value) {
          const ph = getComputedStyle(el, "::placeholder");
          // Its own token: the one in a "::placeholder" rule for this field (the field's text colour token
          // would win in Figma and turn the grey placeholder into the text colour).
          let phToken: string | undefined;
          for (const sheet of Array.from(document.styleSheets)) {
            let rules: CSSRuleList;
            try {
              rules = sheet.cssRules;
            } catch {
              continue;
            }
            for (const r of Array.from(rules)) {
              if (!(r instanceof CSSStyleRule) || !r.selectorText.includes("::placeholder")) continue;
              const base = r.selectorText.replace(/::placeholder/g, "");
              try {
                if (el.matches(base)) phToken = tokenIn(r.style.getPropertyValue("color")) ?? phToken;
              } catch {
                // a selector the browser can't match on its own
              }
            }
          }
          const own = hex(cs.color);
          const phHex = hex(ph.color) ?? text.color.value;
          text.color = tok(phHex, phToken ?? (phHex === own ? tokenIn(declaredUp(el, "color")) : undefined));
        }
        // Single-line fields centre their text vertically; it fills the field's width.
        if (node.layout && tag !== "TEXTAREA") node.layout.justify = "CENTER";
        // Measured as Figma lays it out: the field's content width, one line tall (or the area, for a textarea).
        const box = contentBox(el, cs);
        const lineH = text.lineHeight || renderedLineHeight(el) || px(cs.fontSize) * 1.2;
        const height = tag === "TEXTAREA" ? box.h : round(Math.min(box.h, lineH));
        // A date field: Chrome draws its calendar button at the right (Live showed the bare value).
        const calendar = PICKERS.has(type) && cs.getPropertyValue("-webkit-appearance") !== "none";
        if (calendar && node.layout) {
          node.layout.direction = "HORIZONTAL";
          node.layout.align = "CENTER";
          node.layout.justify = "MIN";
          node.layout.gap = tok(4);
        }
        node.children = [
          {
            name: value ? "value" : "placeholder",
            type: "TEXT",
            width: box.w,
            height,
            sizing: { w: "fill", h: "hug" },
            text,
            at: {
              x: round(rect.left - rootBox.left + px(cs.paddingLeft) + px(cs.borderLeftWidth)),
              y: round(rect.top - rootBox.top + (rect.height - height) / 2),
            },
          },
        ];
        if (calendar) {
          const c = hex(cs.color) ?? "#000000";
          node.children[0]!.width = round(box.w - 20);
          node.children.push({
            name: "calendar",
            type: "SVG",
            width: 16,
            height: 16,
            sizing: { w: "fixed", h: "fixed" },
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="10" rx="1" fill="none" stroke="${c}"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="${c}"/></svg>`,
            at: {
              x: round(rect.right - rootBox.left - px(cs.paddingRight) - px(cs.borderRightWidth) - 16),
              y: round(rect.top - rootBox.top + (rect.height - 16) / 2),
            },
          });
        }
        return node;
      }
    }

    // Mixed content: element children plus loose text → text nodes in DOM order.
    const children: IRNode[] = [];
    // Margins along the layout direction become spacer layers ("<layer>-margin"): Figma has no per-child
    // margins, and a visible spacer is what designers use. Block containers collapse adjacent margins.
    const vertical = node.layout?.direction === "VERTICAL";
    const spacing = node.layout && node.layout.direction !== "GRID";
    const blockFlow = !flex;
    let prevAfter = 0;
    // An auto margin (ml-auto pushing the item to the end) takes the room that's left in Figma too, rather than
    // the pixels it had: slightly wider text pushed the item onto a line of its own.
    const spacer = (forName: string, size: number, token: string | undefined, before: boolean, grow = false): IRNode => ({
      name: before ? `${forName}-margin-${vertical ? "top" : "left"}` : `${forName}-margin`,
      type: "FRAME",
      width: vertical ? 0 : size,
      height: vertical ? size : 0,
      sizing: vertical ? { w: "fill", h: grow ? "fill" : "fixed" } : { w: grow ? "fill" : "fixed", h: "fill" },
      layout: {
        direction: vertical ? "VERTICAL" : "HORIZONTAL",
        gap: tok(0),
        padding: [tok(0), tok(0), tok(0), tok(0)],
        align: "MIN",
        justify: "MIN",
      },
      ...(token ? { spaceToken: token } : {}),
    });
    if (para) {
      // One paragraph (see paragraph()): its text fills the content box when it wraps or is centred in it.
      const runBox = para.range.getBoundingClientRect();
      const placed = !!para.text.align && para.text.align !== "JUSTIFIED" && blockInFlow(el, cs);
      const wraps = para.lines > 1 || placed;
      children.push({
        name: "text",
        type: "TEXT",
        width: wraps ? contentBox(el, cs).w : round(runBox.width),
        height: para.text.lineHeight ? round(para.lines * para.text.lineHeight) : round(runBox.height),
        sizing: { w: wraps ? "fill" : "hug", h: "hug" },
        text: para.text,
        at: place(runBox),
      });
    }
    for (const n of para ? [] : runsOf(flow)) {
      if (n instanceof Node && n.nodeType === Node.ELEMENT_NODE && elementKids.includes(n as HTMLElement)) {
        const kid = n as HTMLElement;
        const kcs = getComputedStyle(kid);
        const child = walk(kid);
        if (onTop(kid) && el !== root) {
          overlays.push({ node: child, z: parseInt(kcs.zIndex, 10) || 0 });
          continue;
        }
        if (kcs.position !== "static") zOf.set(child, kcs.zIndex === "auto" ? 0 : parseInt(kcs.zIndex, 10) || 0);
        if (!spacing || kcs.position === "absolute") {
          children.push(child);
          continue;
        }
        const [s0, s1, i0, i1] = vertical ? (["top", "bottom", 0, 2] as const) : (["left", "right", 3, 1] as const);
        let mBefore = px(kcs.getPropertyValue(`margin-${s0}`));
        const mAfter = px(kcs.getPropertyValue(`margin-${s1}`));
        if (blockFlow && vertical) mBefore = Math.max(0, mBefore - prevAfter);
        // Flex boxes don't collapse margins: the first child's leading margin is space too.
        if (mBefore > 0 && (children.length || !blockFlow))
          children.push(spacer(child.name, mBefore, sideToken(kid, "margin", i0, `margin-${s0}`), true, !blockFlow && autoMargin(kid, s0)));
        children.push(child);
        if (mAfter > 0 && (n !== elementKids[elementKids.length - 1] || !blockFlow))
          children.push(spacer(child.name, mAfter, sideToken(kid, "margin", i1, `margin-${s1}`), false, !blockFlow && autoMargin(kid, s1)));
        prevAfter = mAfter;
      } else if (!(n instanceof Node)) {
        // A list item's bullet or number goes before its first words.
        const t = (children.length ? "" : markerOf(el, cs)) + shownText(n.raw, cs.whiteSpace);
        // Width/height of a bare text run aren't measurable on their own; the frame is what's measured.
        const label = elementKids.length === 0 ? "label" : "text";
        // A run the browser wraps onto several lines wraps in Figma too: it fills its box (M6: chat bubbles).
        const range = n.range();
        const tops = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
        const text = textOf(el, cs, t);
        // The only content of a block, centred or right-aligned in it: placed within the block's width, which
        // a run hugging its words loses (Live: "No conversations yet." at the left of its card, not centred).
        const placed = elementKids.length === 0 && !!text.align && text.align !== "JUSTIFIED" && blockInFlow(el, cs);
        const wrapsHere = tops.size > 1 || !!text.maxLines || placed;
        // Its size as rendered: the run's box; a wrapping run that is the only content fills the content box.
        const runBox = range.getBoundingClientRect();
        const alone = elementKids.length === 0 && wrapsHere;
        const width = alone ? contentBox(el, cs).w : round(runBox.width);
        // Its lines' height (the glyph box is taller than a tight line-height: 21 vs 16).
        const height = text.lineHeight ? round(tops.size * text.lineHeight) : round(runBox.height);
        children.push({
          name: label,
          type: "TEXT",
          width,
          height,
          sizing: { w: wrapsHere ? "fill" : "hug", h: "hug" },
          text,
          at: place(runBox),
        });
      }
    }
    // Boxes CSS draws with ::before / ::after (an active tab's underline, a dot, a divider): layers of their own,
    // placed where they're drawn (Live had no underline under the selected tab). Only boxes, not generated text.
    for (const which of ["::before", "::after"] as const) {
      const box = pseudoBox(el, cs, which);
      if (box) which === "::before" ? children.unshift(box) : children.push(box);
    }
    // A grid's items in the order it shows them, row by row, as Figma fills a grid: one filled column by column
    // (grid-auto-flow: column) or reordered by CSS put "What's a good recipe…" beside the first chip, not under it.
    if (display === "grid" || display === "inline-grid") {
      const slots = children.map((c, i) => (c.absolute || !c.at ? -1 : i)).filter((i) => i >= 0);
      // Rows by overlap, not by exact top: a thin bar centred in a row starts lower than the texts beside it
      // (it was taken for a later row and drawn in the last column, past the card).
      const byTop = slots.map((i) => children[i]!).sort((a, b) => a.at!.y - b.at!.y);
      const rows: IRNode[][] = [];
      let bottom = Number.NEGATIVE_INFINITY;
      for (const c of byTop) {
        if (!rows.length || c.at!.y >= bottom - 0.5) {
          rows.push([c]);
          bottom = c.at!.y + c.height;
        } else {
          rows[rows.length - 1]!.push(c);
          bottom = Math.max(bottom, c.at!.y + c.height);
        }
      }
      const shown = rows.flatMap((r) => r.sort((a, b) => a.at!.x - b.at!.x));
      slots.forEach((slot, j) => {
        children[slot] = shown[j]!;
      });
    }
    if (spansAsRow) for (const c of children) if (!c.absolute && c.sizing.w !== "fixed") c.sizing = { ...c.sizing, w: "fixed" };
    if (children.length) node.children = paintOrder(children);
    // Inline content on one line (a text run and a <span>, an inline label) sits side by side, not stacked;
    // the line box (the parent's line-height) can be taller than what's in it.
    if (
      blockFlow &&
      !para &&
      node.layout?.direction === "VERTICAL" &&
      elementKids.length &&
      elementKids.every((k) => getComputedStyle(k).display.startsWith("inline"))
    ) {
      const boxes = runsOf(flow).flatMap((n) => {
        if (!(n instanceof Node)) return [n.range().getBoundingClientRect()];
        return n.nodeType === Node.ELEMENT_NODE && elementKids.includes(n as HTMLElement)
          ? [(n as HTMLElement).getBoundingClientRect()]
          : [];
      });
      const first = boxes[0]!;
      if (boxes.every((b) => b.top < first.bottom - 0.5 && b.bottom > first.top + 0.5)) {
        const gaps = boxes.slice(1).map((b, i) => b.left - boxes[i]!.right);
        node.layout.direction = "HORIZONTAL";
        node.layout.align = "CENTER";
        node.layout.gap = tok(gaps.length ? round(Math.max(0, Math.min(...gaps))) : 0);
        const content = contentBox(el, cs).h;
        if (node.sizing.h === "hug" && content > Math.max(...boxes.map((b) => b.height)) + 0.5)
          node.sizing = { ...node.sizing, h: "fixed" };
      }
    }
    // Margins across the layout direction (an icon with margin: 3px in a button): the space every in-flow
    // child keeps from the sides becomes padding (Figma has no per-child margins).
    const inFlow = elementKids.filter((k) => !["absolute", "fixed"].includes(getComputedStyle(k).position));
    // (Not for inline content laid out as a row above: its margins are already the gaps.)
    const sameDirection = node.layout?.direction === (vertical ? "VERTICAL" : "HORIZONTAL");
    if (spacing && inFlow.length && node.layout && sameDirection) {
      const sides = vertical ? ([3, 1] as const) : ([0, 2] as const);
      for (const i of sides) {
        const name = ["top", "right", "bottom", "left"][i]!;
        const m = Math.min(...inFlow.map((k) => px(getComputedStyle(k).getPropertyValue(`margin-${name}`))));
        if (m > 0) node.layout.padding[i] = tok(round(node.layout.padding[i].value + m));
      }
    }
    return scrolled(el, cs, node);
  };
  /**
   * A panel scrolled down (or across) shows its content moved by that much: its content as one layer, placed at
   * minus the scroll inside the panel, which clips it. Live drew it from the top (behind a dialog, the details
   * panel showed its first rows where the browser showed rows 531px further down).
   */
  const scrolled = (el: HTMLElement, ecs: CSSStyleDeclaration, node: IRNode): IRNode => {
    const st = Math.round(el.scrollTop);
    const sl = Math.round(el.scrollLeft);
    if ((st < 1 && sl < 1) || !node.layout || !node.children?.length) return node;
    const bl = px(ecs.borderLeftWidth);
    const bt = px(ecs.borderTopWidth);
    const zero = tok(0);
    const inFlow = node.children.filter((c) => !c.absolute);
    const outOfFlow = node.children.filter((c) => c.absolute);
    const content: IRNode = {
      name: "scrolled",
      type: "FRAME",
      width: round(sl > 0 ? el.scrollWidth : el.clientWidth),
      height: round(st > 0 ? el.scrollHeight : el.clientHeight),
      sizing: { w: "fixed", h: "fixed" },
      layout: node.layout,
      children: inFlow,
      absolute: { x: round(bl - sl), y: round(bt - st) },
      ...(node.at ? { at: { x: round(node.at.x + bl - sl), y: round(node.at.y + bt - st) } } : {}),
    };
    return {
      ...node,
      clip: true,
      sizing: { ...node.sizing, h: node.sizing.h === "hug" ? "fixed" : node.sizing.h },
      layout: { direction: "VERTICAL", gap: zero, padding: [zero, zero, zero, zero], align: "MIN", justify: "MIN" },
      children: [content, ...outOfFlow],
    };
  };
  /** Layers fixed to the window, found anywhere on the page: on top of the page, in the order found. */
  const overlays: { node: IRNode; z: number }[] = [];
  const page = walk(root);
  // Stacked by z-index, as the browser stacks them (in the order found when equal): a dialog with z-index 999
  // over one with 70, though it comes first in the page (Live drew the "From a website" dialog over the pages
  // picker opened from it).
  overlays.sort((a, b) => a.z - b.z);
  if (overlays.length) page.children = [...(page.children ?? []), ...overlays.map((o) => o.node)];
  return page;
}
