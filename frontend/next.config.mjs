/**
 * The browser must talk to the API on its own origin, otherwise the HttpOnly
 * session cookie (SameSite=Strict) is never sent and cross-site callers are
 * refused by the API's CORS allow-list. Proxying `/api/*` through the frontend
 * origin keeps cookies first-party and removes CORS from the picture entirely.
 *
 * `BACKEND_API_URL` is read at build time (it is server-side only, never exposed
 * to the browser). It defaults to the local API for `next dev`.
 */
const BACKEND_API_URL = (process.env.BACKEND_API_URL || "http://localhost:5000").replace(
  /\/+$/,
  ""
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_API_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
