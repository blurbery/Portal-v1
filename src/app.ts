import express, { type Express } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import { loadEnv, type PortalEnv } from './config/env';
import { createDatabase, type PortalDatabase } from './db';
import { setDb } from './state';
import { csrfProtection, csrfTokenHandler, createAuthRateLimiter } from './middleware/security';
import { registerAllRoutes } from './routes';
import { bootstrapPortalSettings } from './portal/register';

export type CreateAppOptions = {
  env?: PortalEnv;
  database?: PortalDatabase;
  /** Skip loading encrypted settings (used in unit tests). */
  skipSettingsLoad?: boolean;
};

export async function createApp(options: CreateAppOptions = {}): Promise<{
  app: Express;
  env: PortalEnv;
  db: PortalDatabase;
}> {
  const env = options.env || loadEnv();
  const db = options.database || createDatabase(env.DATABASE_URL);
  setDb(db);

  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'https:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true, limit: '4mb' }));
  app.use(cookieParser());

  app.get('/admin.html', (_req, res) => res.redirect('/dashboard#administration'));
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.use(session({
    name: 'portal.sid',
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }));

  app.use(csrfProtection);
  app.get('/api/csrf-token', csrfTokenHandler);

  const authLimiter = createAuthRateLimiter();
  app.use('/auth/login', authLimiter);
  app.use('/auth/emby-connect/login', authLimiter);
  app.use('/api/forgot-password', authLimiter);

  app.get('/api/health', async (_req, res) => {
    try {
      await db.pool.query('SELECT 1');
      res.json({ ok: true, database: 'ok', version: process.env.npm_package_version || '2.0.0' });
    } catch (error: any) {
      res.status(503).json({ ok: false, database: 'error', error: error.message });
    }
  });

  registerAllRoutes(app);

  if (!options.skipSettingsLoad) {
    await bootstrapPortalSettings();
  }

  return { app, env, db };
}
