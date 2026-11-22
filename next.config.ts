import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* التحقق من الأنواع مفعّل أثناء البناء — فحص tsc نظيف */
  reactStrictMode: false,
};

export default nextConfig;
