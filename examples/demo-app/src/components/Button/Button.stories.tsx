import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";

const PlusIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M7 3h2v4h4v2H9v4H7V9H3V7h4z" /></svg>
);

const meta = {
  title: "Button",
  component: Button,
  args: { label: "Button", variant: "primary", size: "md", disabled: false },
  argTypes: {
    variant: { control: "inline-radio", options: ["primary", "secondary"] },
    size: { control: "inline-radio", options: ["sm", "md"] },
    leadingIcon: { control: false },
    onClick: { control: false },
  },
} satisfies Meta<typeof Button>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Secondary: Story = { args: { variant: "secondary" } };
export const Small: Story = { args: { size: "sm" } };
export const Disabled: Story = { args: { disabled: true } };
export const WithIcon: Story = { args: { leadingIcon: <PlusIcon /> } };
