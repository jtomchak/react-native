import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default {
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  agentRules: false,
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  images: {unoptimized: true},
  outputFileTracingRoot: root,
  turbopack: {root},
};
