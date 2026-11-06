// Import the renderer normally, then attach it before its first render. The
// compiler-injected permanent Refresh runtime must already have run.
export function attachRefreshRenderer(reconciler) {
  if (typeof globalThis.__nhRegisterRefreshRenderer !== 'function') throw new Error('Refresh runtime must precede renderer initialization');
  globalThis.__nhRegisterRefreshRenderer(reconciler);
}
