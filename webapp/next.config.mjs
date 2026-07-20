/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No eslint in this package on purpose (minimal deps); typecheck runs in `next build`.
  eslint: { ignoreDuringBuilds: true },
  // Private family tool — never let anything index it.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
