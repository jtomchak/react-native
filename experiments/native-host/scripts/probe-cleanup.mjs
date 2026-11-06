export async function restoreThenStop(restore, stop) {
  const errors = [];
  try { await restore(); } catch (error) { errors.push(error); }
  finally {
    try { await stop(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Probe cleanup failed');
}

export function describeError(error) {
  return {
    name: error?.name || 'Error', message: error?.message || String(error),
    ...(error?.code ? {code: error.code} : {}),
    ...(error instanceof AggregateError ? {errors: error.errors.map(describeError)} : {}),
  };
}
