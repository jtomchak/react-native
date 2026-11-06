'use client';

import {usePlatform} from '../../../packages/platform-react/index.jsx';
import {useAuth as usePackageAuth} from '@nativehost/auth/react';

export {PlatformProvider, usePlatform, useNativeAction, NativeToolbar, NativeLink} from '../../../packages/platform-react/index.jsx';
export function useAuth() { return usePackageAuth(usePlatform()); }

const storageActions = ['storage.get', 'storage.set', 'storage.remove'];
export function useStorageUnavailable() {
  const {platform, capabilities, connection} = usePlatform();
  return !!platform && (!platform.storage || (connection === 'connected' && !storageActions.every(action => capabilities.capabilities.includes(action))));
}
export async function requireStorage(api) {
  if (!api.storage) throw new api.PlatformError('UNSUPPORTED', 'Native storage is unavailable in this app.');
  const ready = await api.ready();
  if (!storageActions.every(action => ready.capabilities.includes(action))) throw new api.PlatformError('UNSUPPORTED', 'Native storage is unavailable in this app.');
  return api.storage;
}
