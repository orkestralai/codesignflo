import { describe, expect, it } from "vitest";
import { keyOfTitle, pascalOf } from "./key.js";

describe("component keys", () => {
  it("Storybook titles and designer names give the same key", () => {
    expect(keyOfTitle("ProductCard")).toBe("product-card");
    expect(keyOfTitle("Forms/Text Input")).toBe("forms.text-input");
    expect(keyOfTitle("Promo banner")).toBe("promo-banner");
    expect(keyOfTitle(pascalOf("Promo banner"))).toBe("promo-banner");
  });
  it("code names are PascalCase", () => {
    expect(pascalOf("promo banner")).toBe("PromoBanner");
    expect(pascalOf("promo-banner")).toBe("PromoBanner");
    expect(pascalOf("PromoBanner")).toBe("PromoBanner");
    expect(pascalOf("FAQ list")).toBe("FaqList");
  });
});

describe("page names", () => {
  it("name → page component, story, screen key", async () => {
    const { pageNames } = await import("./key.js");
    expect(pageNames("Checkout")).toEqual({ key: "pages.checkout-page", component: "Checkout", story: "CheckoutPage" });
    expect(pageNames("Order summary page")).toEqual({
      key: "pages.order-summary-page",
      component: "OrderSummary",
      story: "OrderSummaryPage",
    });
  });
});
