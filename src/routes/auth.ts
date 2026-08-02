/**
 * auth HTTP routes.
 * Registrar implementation lives in src/portal/register.ts (registerAuthRoutes)
 * alongside shared helpers so handler closures keep working after the JS→TS split.
 */
export { registerAuthRoutes } from '../portal/register';
