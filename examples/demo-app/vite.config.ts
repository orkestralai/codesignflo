import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  css: {
    // Readable, stable class names ("ProductCard-module__title"): the CoDesignFlo extractor uses them as layer names.
    modules: { generateScopedName: "[name]__[local]" },
  },
});
