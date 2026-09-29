import createNextIntlPlugin from "next-intl/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@cherrio/ui", "@cherrio/shared"],
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default withNextIntl(nextConfig);
