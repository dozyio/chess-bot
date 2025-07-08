import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactStrictMode: true,
  basePath: process.env.GITHUB_PAGES ? '/chess-bot' : '',
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
