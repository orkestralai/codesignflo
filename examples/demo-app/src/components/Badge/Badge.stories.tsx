import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "./Badge";

const meta = {
  title: "Badge",
  component: Badge,
  args: { label: "New", tone: "neutral" },
  argTypes: { tone: { control: "inline-radio", options: ["neutral", "sale"] } },
} satisfies Meta<typeof Badge>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Neutral: Story = {};
export const Sale: Story = { args: { label: "-20%", tone: "sale" } };
