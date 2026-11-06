export function validateConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new Error('Native storage configuration must be an empty object');
  }
  return {};
}
