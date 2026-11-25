import type { Meta, StoryObj } from "@storybook/react-vite";
import { Header } from "./Header";

const meta = {
  title: "Header",
  component: Header,
  args: { cartCount: 2 },
  decorators: [
    (Story) => (
      <div data-cdf-container style={{ width: 1024 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Header>;
export default meta;

export const Default: StoryObj<typeof meta> = {};
