// Reuse the checkout's installed RN Babel transformer, with the same test-only
// compile-time constant as bundle-config.mjs. No RN runtime initialization.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const transformer = require(path.join(process.env.NH_BENCH_REFERENCE, 'node_modules/@react-native/metro-babel-transformer'));
module.exports = {
  ...transformer,
  transform(args) {
    return transformer.transform({...args, plugins: [...(args.plugins || []), ({types: t}) => ({
      visitor: {ReferencedIdentifier(p) { if (p.node.name === '__NH_TEST_HOOKS__') p.replaceWith(t.booleanLiteral(true)); }},
    })]});
  },
  getCacheKey() {
    return crypto.createHash('sha256').update(transformer.getCacheKey()).update(fs.readFileSync(__filename)).digest('hex');
  },
};
