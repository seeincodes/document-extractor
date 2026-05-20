import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @napi-rs/canvas ships a platform-specific native binary that the
  // bundler cannot place; pdfjs-dist's legacy entry expects a Node
  // environment. Both must be loaded as external CommonJS at runtime
  // rather than bundled into the server output.
  serverExternalPackages: ['@napi-rs/canvas', 'pdfjs-dist'],
};

export default nextConfig;
