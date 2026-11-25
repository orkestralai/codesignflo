// CoDesignFlo's mark: an angular C (code) and a round d (design) holding water, the d cutting into the C with a
// small gap. Transparent everywhere but the letters: the C takes the text colour (black on light, white on dark),
// the d is blue. Each instance gets its own mask ids (a page can show it more than once).

let n = 0;
export const BLUE = "#2563eb";

/** The mark as inline SVG, `height` px tall (width follows). */
export function logoSvg(height = 24): string {
  const i = ++n;
  const cx = 805;
  const cy = 725;
  return `<svg class="logo" height="${height}" viewBox="170 280 900 710" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><defs><mask id="lc${i}"><rect x="0" y="0" width="1200" height="1200" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="265" fill="#000"/></mask><mask id="ld${i}"><rect x="0" y="0" width="1200" height="1200" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="140" fill="#000"/></mask><clipPath id="lw${i}"><circle cx="${cx}" cy="${cy}" r="141"/></clipPath></defs><path mask="url(#lc${i})" fill="currentColor" d="M340 430 L610 430 L610 550 L389.7 550 L310 629.7 L310 770.3 L389.7 850 L610 850 L610 970 L340 970 L190 820 L190 580 Z"/><g mask="url(#ld${i})" fill="${BLUE}"><circle cx="${cx}" cy="${cy}" r="245"/><rect x="930" y="300" width="120" height="670"/></g><path clip-path="url(#lw${i})" fill="${BLUE}" d="M650 800 C 700 770, 760 763, 805 783 S 900 818, 960 786 L 960 900 L 650 900 Z"/></svg>`;
}
