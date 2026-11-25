import type { Meta, StoryObj } from "@storybook/react-vite";
import { QuantityStepper } from "./QuantityStepper";

const meta = {
  title: "QuantityStepper",
  component: QuantityStepper,
  args: { value: 1, disabled: false },
  argTypes: { onChange: { control: false } },
} satisfies Meta<typeof QuantityStepper>;
export default meta;

type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
