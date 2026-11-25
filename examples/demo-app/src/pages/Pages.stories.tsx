import type { Meta, StoryObj } from "@storybook/react-vite";
import { Cart } from "./Cart";
import { Home } from "./Home";
import { Product } from "./Product";

// Screens: each page rendered at a fixed desktop width so CoDesignFlo can build it from Live instances.
const meta = {
  title: "Pages",
  parameters: { layout: "fullscreen" },
  decorators: [
    // A page designed at another width sets parameters.width.
    (Story, ctx) => (
      <div data-cdf-container style={{ width: (ctx.parameters.width as number | undefined) ?? 1024 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta;
export default meta;

export const HomePage: StoryObj = { render: () => <Home /> };
export const ProductPage: StoryObj = { render: () => <Product /> };
export const CartPage: StoryObj = { render: () => <Cart /> };
