import type { Request, Response, NextFunction } from 'express';

export type PortalSessionUser = {
  is_admin?: boolean;
  has_emby?: boolean;
  has_silo?: boolean;
  emby_user_id?: string;
  emby_username?: string;
  discord_username?: string;
  [key: string]: unknown;
};

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!(req.session as any)?.user) {
    if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.redirect('/');
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req.session as any)?.user as PortalSessionUser | undefined;
  if (!user) {
    if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.redirect('/');
    return;
  }
  if (user.is_admin !== true) {
    if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
      res.status(403).json({ error: 'Admin only' });
      return;
    }
    res.redirect('/dashboard');
    return;
  }
  next();
}

export function requireLibraryAccess(req: Request, res: Response, next: NextFunction): void {
  const user = (req.session as any)?.user as PortalSessionUser | undefined;
  const hasStreamingMembership = user?.has_emby === true || user?.has_silo === true || !!user?.emby_user_id;
  if (!hasStreamingMembership) {
    if (req.originalUrl.startsWith('/api/')) {
      res.status(403).json({ error: 'Emby membership required' });
      return;
    }
    res.redirect('/dashboard');
    return;
  }
  next();
}
