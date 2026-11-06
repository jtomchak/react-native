'use client';

import {usePlatform} from '../../../packages/platform-react/index.jsx';
import {useAuth as usePackageAuth} from '@nativehost/auth/react';

export {PlatformProvider, usePlatform, useNativeAction, NativeToolbar, NativeLink} from '../../../packages/platform-react/index.jsx';
export function useAuth() { return usePackageAuth(usePlatform()); }
