// IR: what a rendered component looks like, in terms close to Figma's model. Produced by the
// extractor from the DOM, consumed by the compiler. Plain data, canonical JSON.

export type Sizing = "fixed" | "hug" | "fill";

/** A value plus the design token it came from, when the CSS used var(--token). */
export type Tokened<T> = { value: T; token?: string };

export type IRNode = {
  /** Layer name: CSS-module local class ("title"), else the tag ("svg"). */
  name: string;
  type: "FRAME" | "TEXT" | "IMAGE" | "SVG";
  width: number;
  height: number;
  sizing: { w: Sizing; h: Sizing };
  layout?: {
    direction: "HORIZONTAL" | "VERTICAL" | "GRID";
    /** GRID only: track counts and the gap between rows (gap = column gap). */
    columns?: number;
    rows?: number;
    /** GRID only: each column's width as rendered (1fr 2fr → 276, 552): the tracks keep these proportions. */
    columnSizes?: number[];
    /** HORIZONTAL only: flex-wrap — items flow onto more rows, `rowGap` apart. */
    wrap?: true;
    rowGap?: Tokened<number>;
    gap: Tokened<number>;
    padding: [Tokened<number>, Tokened<number>, Tokened<number>, Tokened<number>]; // top right bottom left
    align: "MIN" | "CENTER" | "MAX" | "STRETCH" | "BASELINE";
    justify: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  };
  fill?: Tokened<string>; // #rrggbb or #rrggbbaa
  /** A CSS linear-gradient background (over `fill`): its angle (CSS degrees: 90 = to the right) and stops. */
  gradient?: { angle: number; stops: { color: Tokened<string>; position: number }[] };
  /** Where it is on the page: its top-left from the story root's (pairs it with the design's layer there). */
  at?: { x: number; y: number };
  /** CSS transform: rotate(): degrees clockwise (width/height are then its size before rotating). */
  rotation?: number;
  /**
   * IMAGE: the picture as rendered (object-fit applied), as a PNG at the element's size × 2. `png` (base64)
   * comes from the page; the CLI swaps it for `ref` (content hash) and uploads each picture once.
   */
  image?: { png?: string; ref?: string };
  /**
   * FRAME: its CSS background pictures and gradients (anything beyond one linear gradient: url() pictures, radial
   * and conic gradients, layers stacked), drawn as the browser draws them at the element's size × 2, over `fill`.
   * Like `image`: `png` from the page, swapped for `ref` by the CLI.
   */
  background?: { png?: string; ref?: string };
  /** `sides` (top, right, bottom, left) only when they differ, e.g. a border-top only. */
  stroke?: { color: Tokened<string>; width: number; sides?: [number, number, number, number]; dash?: [number, number] };
  radius?: Tokened<number>;
  /** Each corner (top-left, top-right, bottom-right, bottom-left) when they differ: tabs, sheets, joined buttons. */
  radii?: [number, number, number, number];
  opacity?: number;
  clip?: boolean;
  /** CSS box-shadow (computed); on a text, its text-shadow. */
  shadow?: string;
  /** CSS filter and backdrop-filter (computed): blurs and drop-shadows become Figma effects. */
  filter?: string;
  backdrop?: string;
  /** CSS mix-blend-mode, when not normal. */
  blend?: string;
  /** CSS outline (focus rings, selected states): drawn outside the box. */
  outline?: { color: string; width: number };
  text?: {
    characters: string;
    fontFamily: string;
    fontWeight: Tokened<number>;
    fontSize: Tokened<number>;
    lineHeight: number;
    letterSpacing: number;
    color: Tokened<string>;
    maxLines?: number;
    /** Horizontal alignment inside its box when not left (matters when the box is wider than the text). */
    align?: "CENTER" | "RIGHT" | "JUSTIFIED";
    /** CSS text-transform. */
    case?: "UPPER" | "LOWER" | "TITLE";
    /** Italic (font-style). */
    italic?: true;
    /** The whole text underlined or struck through (text-decoration-line). */
    decoration?: "UNDERLINE" | "STRIKETHROUGH";
    /** Where the text links to (an <a href> around it): a URL, mailto: or tel:, kept as a link in Figma. */
    link?: string;
    /**
     * Parts styled differently from the rest (a bold email inside a sentence, a link): one text layer, as the
     * paragraph flows in the browser. `start`/`end` index `characters`; only what differs is given.
     */
    runs?: TextRun[];
  };
  svg?: string;
  /** Spacer layer for a CSS margin: the token its size comes from. */
  spaceToken?: string;
  /**
   * CSS position absolute/fixed: not in its parent's flow, at this offset from the parent's top-left (an
   * overlay, a scrim, a badge on a corner). Figma: an absolutely positioned layer in the auto-layout parent.
   */
  absolute?: { x: number; y: number };
  /**
   * CSS min/max width and height in pixels, on a layer that fills or hugs: Figma keeps them when a designer resizes
   * (a card that fills its column but stops at 480, a button never narrower than 96).
   */
  limits?: { minW?: number; maxW?: number; minH?: number; maxH?: number };
  /** An iframe: its index among the page's iframes (the CLI reads what it shows into its children). */
  iframe?: number;
  /** No semantic name in code (no data-cdf, no CSS-module class): named after its tag for now. */
  unnamed?: true;
  /** The CSS module its classes come from (whose markup it is: the component's own, or the page's). */
  module?: string;
  /** The element's class names, sorted (Tailwind and other utility classes: how a component is told apart where no CSS module names it). */
  cls?: string;
  /** This frame is the root of another registered component (an instance in Figma); on a story's root, its own. */
  component?: { module: string; classes: string[] };
  children?: IRNode[];
};

export type IRStory = { story: string; root: IRNode };

/** A styled part of a text (see `text.runs`). */
export type TextRun = {
  start: number;
  end: number;
  fontFamily?: string;
  fontWeight?: number;
  italic?: boolean;
  fontSize?: number;
  color?: string;
  underline?: boolean;
  strikethrough?: boolean;
  /** Where this part links to (an <a href> inside the paragraph); "" for a part outside the text's own link. */
  link?: string;
};
