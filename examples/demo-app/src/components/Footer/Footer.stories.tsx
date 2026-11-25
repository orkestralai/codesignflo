import type { Meta, StoryObj } from "@storybook/react-vite";
import { Footer } from "./Footer";

const meta = {
  title: "Footer",
  component: Footer,
  decorators: [
    (Story) => (
      <div data-cdf-container style={{ width: 1024 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Footer>;
export default meta;

export const Default: StoryObj<typeof meta> = {};
