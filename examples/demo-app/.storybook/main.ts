import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  // The demo's first stage (STORYBOOK_DEMO_STAGE=1) is the shop before Alex ships the Free shipping badge.
  stories: process.env.STORYBOOK_DEMO_STAGE === "1" ? ["../src/components/!(ShippingBadge)/*.stories.tsx", "../src/pages/*.stories.tsx"] : ["../src/**/*.stories.tsx"],
  staticDirs: ["../public"],
  framework: { name: "@storybook/react-vite", options: {} },
};
export default config;
