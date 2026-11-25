import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProductCard } from "./ProductCard";

// Rendered inside a fixed-width container so `width: 100%` (fill) is observable.
// S4 re-renders with a different container width to recover layout intent.
const meta = {
  title: "ProductCard",
  component: ProductCard,
  args: { title: "Linen shirt", price: "€49", imageUrl: "/product.svg", onSale: false },
  argTypes: { onAddToCart: { control: false } },
  parameters: { containerWidth: 320 },
  decorators: [
    (Story, ctx) => (
      <div data-cdf-container style={{ width: (ctx.parameters.containerWidth as number) ?? 320 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProductCard>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const OnSale: Story = { args: { onSale: true } };
export const FreeShipping: Story = { args: { freeShipping: true } };
export const LongTitle: Story = { args: { title: "Wool scarf with a long name that wraps onto two lines" } };
