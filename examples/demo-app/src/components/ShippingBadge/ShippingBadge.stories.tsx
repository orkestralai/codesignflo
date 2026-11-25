import type { Meta, StoryObj } from "@storybook/react-vite";
import { ShippingBadge } from "./ShippingBadge";

const meta = { title: "ShippingBadge", component: ShippingBadge, args: { label: "Free shipping" } } satisfies Meta<typeof ShippingBadge>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
