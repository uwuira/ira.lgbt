import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Read in Node, handed to the test setup as a binding — `cloudflare:test`
        // can only apply migrations from inside the Worker.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(here, "migrations")),
          // Deterministic stand-ins for the deployed secrets. These override
          // .dev.vars, which wrangler also loads here — without pinning every
          // one of them the suite would quietly test whatever happens to be in
          // a developer's local file. ADMIN_DEV_BYPASS especially: inheriting
          // it turns every admin authorisation test green for the wrong reason.
          ADMIN_DEV_BYPASS: "",
          SENDER_SECRET: "test-sender-secret",
          IP_SALT: "test-ip-salt",
          SPOTIFY_CLIENT_ID: "test-client-id",
          SPOTIFY_CLIENT_SECRET: "test-client-secret",
          SPOTIFY_REFRESH_TOKEN: "test-refresh-token",
          ACCESS_TEAM_DOMAIN: "https://ira.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag-for-the-admin-app",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.js"],
  },
});
