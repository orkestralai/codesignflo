import type { Meta, StoryObj } from "@storybook/react-vite";
import { TipCard } from "./TipCard";

const meta = {
  title: "TipCard",
  component: TipCard,
  args: { title: "Free shipping", body: "Orders over €50 ship free to the whole EU." },
} satisfies Meta<typeof TipCard>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
