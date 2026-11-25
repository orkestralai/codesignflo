// Component keys, shared by the CLI (Storybook titles) and the plugin (names the designer types), so the
// same name gives the same key on both sides (brief §3.2b).

/** "ProductCard" → "product-card"; "Forms/Text Input" → "forms.text-input"; "Promo banner" → "promo-banner". */
export const keyOfTitle = (title: string) =>
  title
    .split("/")
    .map((p) =>
      p
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase(),
    )
    .join(".");

/** "promo banner" / "promo-banner" → "PromoBanner": the component (and Storybook title) name in code. */
export const pascalOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join("");

/**
 * A designed page's names: "Checkout" (or "Checkout page") → page component `Checkout`, Storybook story
 * `CheckoutPage` under "Pages", screen key `pages.checkout-page` (what sync derives from that story).
 */
export const pageNames = (name: string) => {
  const base = keyOfTitle(name).replace(/(^|-)page$/, "") || "new";
  return { key: `pages.${base}-page`, component: pascalOf(base), story: `${pascalOf(base)}Page` };
};
