/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  serverExternalPackages: ['better-sqlite3'],
  async headers() {
    // API payloads include biometrics, credentials, and other private data.
    return [{
      source: '/api/:path*',
      headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
    }];
  },
};

module.exports = nextConfig;
