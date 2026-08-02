import type { Express } from 'express';
import { registerAllPortalRoutes } from '../portal/register';
export {
  registerAuthRoutes,
  registerDashboardRoutes,
  registerSeerrRoutes,
  registerLibrariesRoutes,
  registerAdminRoutes,
  registerReadersRoutes,
  registerPushRoutes,
  registerAllPortalRoutes,
} from '../portal/register';

export function registerAllRoutes(app: Express): void {
  registerAllPortalRoutes(app);
}
