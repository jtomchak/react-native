export function installStorage({call}) {
  return {
    namespace: {
      get: (key, options) => call('storage.get', {key}, options),
      set: (key, value, options) => call('storage.set', {key, value}, options),
      remove: (key, options) => call('storage.remove', {key}, options),
    },
  };
}
