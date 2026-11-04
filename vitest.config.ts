import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // server-only throws outside a React Server context; its react-server target is a no-op.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
    // Blank every key that could spend money or change mode, so a developer's shell can't leak in.
    // Empty means unset. No secret or placeholder secret belongs here.
    env: {
      APP_DEPLOYMENT: "local",
      ANTHROPIC_API_KEY: "",
      SPEND_LEDGER_URL: "",
      AGENT_REPLAY: "",
      AGENT_RECORD: "",
      DEMO_NOW: "",
      VERCEL: "",
      VERCEL_ENV: "",
      VERCEL_URL: "",
    },
  },
});
