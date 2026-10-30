import type { NextConfig } from "next";

// Keep standalone build tracing scoped to this app even though the backend has its own lockfile.
const nextConfig: NextConfig = { outputFileTracingRoot: process.cwd() };

export default nextConfig;
