import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export default {
  output: 'standalone',
  distDir: '.next-server',
  trailingSlash: true,
  reactStrictMode: true,
  images: {unoptimized: true},
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  agentRules: false,
  outputFileTracingRoot: root,
  turbopack: {root},
};
