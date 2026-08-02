/**
 * push HTTP routes.
 * Registrar implementation lives in src/portal/register.ts (registerPushRoutes)
 * alongside shared helpers so handler closures keep working after the JS→TS split.
 */
export { registerPushRoutes } from '../portal/register';
