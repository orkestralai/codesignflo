import type { Meta, StoryObj } from "@storybook/react-vite";
import { CartItem } from "./CartItem";

const meta = {
  title: "CartItem",
  component: CartItem,
  args: { title: "Canvas tote", price: "€19", imageUrl: "/product.svg", quantity: 1, onSale: false },
  decorators: [
    (Story) => (
      <div data-cdf-container style={{ width: 560 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CartItem>;
export default meta;

type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const OnSale: Story = { args: { title: "Linen shirt", price: "€49", onSale: true, quantity: 2 } };
