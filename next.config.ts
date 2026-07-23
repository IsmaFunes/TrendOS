import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.mlstatic.com",
      },
      {
        protocol: "http",
        hostname: "http2.mlstatic.com",
      },
    ],
  },
};

export default nextConfig;
