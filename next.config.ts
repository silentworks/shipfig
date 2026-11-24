import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Sprites SDK uses Node built-ins (WebSocket, crypto) and must not be bundled.
  serverExternalPackages: ["@fly/sprites"],
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
