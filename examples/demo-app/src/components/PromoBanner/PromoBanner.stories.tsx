import type { Meta, StoryObj } from "@storybook/react-vite";
import { PromoBanner } from "./PromoBanner";

const meta = {
  title: "PromoBanner",
  component: PromoBanner,
  args: { title: "Summer sale", description: "Up to 30% off on selected items until Sunday." },
} satisfies Meta<typeof PromoBanner>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
