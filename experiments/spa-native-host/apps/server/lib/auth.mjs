// Application-specific SSR convenience. The generated registry can omit auth;
// no authentication dependency is eagerly imported by the application adapter.
import {serverPlugins} from '../../../build/plugins/server.mjs';

export async function authService() { return serverPlugins.auth?.authService() ?? null; }
export function cookieName(service) { return serverPlugins.auth?.cookieName(service); }
