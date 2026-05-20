import type { NextConfig } from 'next';

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

const nextConfig: NextConfig = {
  async rewrites() {
    // 把后端 REST/SSE 路径透传到 Express，避免开发期 CORS 与改前缀
    return [
      { source: '/api/health', destination: `${BACKEND}/health` },
      { source: '/api/sessions/:path*', destination: `${BACKEND}/sessions/:path*` },
      { source: '/api/sessions', destination: `${BACKEND}/sessions` },
      { source: '/api/traces/:path*', destination: `${BACKEND}/traces/:path*` },
      { source: '/api/traces', destination: `${BACKEND}/traces` },
      { source: '/api/memory/:path*', destination: `${BACKEND}/memory/:path*` },
      { source: '/api/memory', destination: `${BACKEND}/memory` },
      { source: '/api/events', destination: `${BACKEND}/events` },
      { source: '/api/uploads/:path*', destination: `${BACKEND}/uploads/:path*` },
      { source: '/api/uploads', destination: `${BACKEND}/uploads` },
    ];
  },
  reactStrictMode: true,
};

export default nextConfig;
