import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  globalIgnores([
    ".next/**",
    "out/**",
    // Generated Next.js build output can also live inside leftover preview copies
    // (e.g. .production-preview-*/). Ignore nested build output so lint only sees real source.
    "**/.next/**",
    "**/out/**",
    ".production-preview-*/**",
    "backups/**",
    "backup/**",
    ".approved-baseline/**",
    "artifacts/**",
    "snapshots/**",
  ]),
]);
