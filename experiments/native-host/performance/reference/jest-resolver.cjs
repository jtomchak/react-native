const path = require('node:path');
const reference = path.resolve(__dirname, '../../build/reference');
const base = require(path.join(reference, 'packages/jest-preset/jest/resolver.js'));

module.exports = (request, options) => {
  try { return base(request, options); }
  catch (error) {
    // Metro resolves a density-only asset (for example relay@3x.png) from
    // require('relay.png'). Stock Jest's resolver lacks that asset behavior.
    if (/\.(png|jpg|jpeg|gif|webp)$/.test(request)) {
      for (const density of [2, 3]) {
        const scaled = request.replace(/(\.[^.]+)$/, `@${density}x$1`);
        try { return base(scaled, options); } catch {}
      }
    }
    throw error;
  }
};
