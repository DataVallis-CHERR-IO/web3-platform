import createNextIntlPlugin from "next-intl/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@cherrio/ui", "@cherrio/shared", "@cherrio/db"],
  outputFileTracingRoot: path.join(__dirname, "../../"),
  experimental: {
    // The middleware runs for /api/* and keeps at most this much of a request
    // body (default 10 MB). A 10 MB private file plus its multipart framing is
    // slightly larger and would be cut. POST /api/files/kyb enforces the real
    // limit (10 MB + 64 KB by Content-Length, then 10 MB for the file itself).
    // Public campaign PDFs (ADR-039) are up to 20 MB, so the middleware keeps 21 MB;
    // every upload route still enforces its own limit by Content-Length.
    middlewareClientMaxBodySize: "21mb",
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    // Optional peer of @privy-io/react-auth (Farcaster mini-app + Solana), not used by CHERR.IO.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@farcaster/mini-app-solana": false,
    };
    return config;
  },
};

export default withNextIntl(nextConfig);
