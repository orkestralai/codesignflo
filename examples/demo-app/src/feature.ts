// The guided demo shows the shop twice: as it starts (stage 1, built with STORYBOOK_DEMO_STAGE=1), and after the
// demo's developer, Alex, ships a new feature built in a hurry, with no design yet: a "Free shipping" badge on the
// products that ship free (stage 2, the default). The designer then fixes its look in the demo.
export const FREE_SHIPPING = (import.meta as { env?: Record<string, string | undefined> }).env?.STORYBOOK_DEMO_STAGE !== "1";
