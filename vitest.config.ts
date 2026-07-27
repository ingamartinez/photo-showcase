import path from "node:path";
import { defineConfig } from "vitest/config";

// Mirrors the "@/*" -> "./src/*" path mapping in tsconfig.json so unit tests
// can use the same import alias as the rest of the app.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
