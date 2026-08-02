import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import type { PortalDatabase } from '../src/db';

const ADMIN_USER = process.env.PORTAL_ADMIN_USERNAME || 'admin';
const ADMIN_PASS = 'admin-dev-password';

describe('auth and CSRF', () => {
  let app: Express;
  let db: PortalDatabase;
  const agent = () => request.agent(app);

  beforeAll(async () => {
    process.env.AUTH_RATE_LIMIT_MAX = '200';
    process.env.COOKIE_SECURE = 'false';
    process.env.NODE_ENV = 'test';
    process.env.PORTAL_DISABLE_WEEKLY_RESTART = 'true';
    const env = loadEnv();
    const created = await createApp({ env });
    app = created.app;
    db = created.db;
  }, 60000);

  afterAll(async () => {
    await db.close();
  });

  it('rejects anonymous access to protected API routes', async () => {
    const res = await request(app).get('/api/account');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not authenticated/i);
  });

  it('rejects anonymous access to /api/admin/*', async () => {
    const res = await request(app).get('/api/admin/config');
    expect(res.status).toBe(401);
  });

  it('issues a CSRF token', async () => {
    const res = await request(app).get('/api/csrf-token');
    expect(res.status).toBe(200);
    expect(res.body.csrfToken).toBeTruthy();
  });

  it('logs in bootstrap admin and reads /api/admin/config', async () => {
    const authed = agent();
    const login = await authed.post('/auth/login').send({ username: ADMIN_USER, password: ADMIN_PASS });
    expect(login.status).toBe(200);
    expect(login.body.success).toBe(true);

    const res = await authed.get('/api/admin/config');
    expect(res.status).toBe(200);
    expect(res.body.fields || res.body.bootstrap).toBeTruthy();
  });

  it('rejects state-changing requests without CSRF token', async () => {
    const authed = agent();
    const login = await authed.post('/auth/login').send({ username: ADMIN_USER, password: ADMIN_PASS });
    expect(login.body.success).toBe(true);

    const res = await authed.post('/api/set-recovery-email').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/csrf/i);
  });

  it('accepts mutating admin request with CSRF token', async () => {
    const authed = agent();
    const login = await authed.post('/auth/login').send({ username: ADMIN_USER, password: ADMIN_PASS });
    expect(login.body.success).toBe(true);

    const csrf = await authed.get('/api/csrf-token');
    const token = csrf.body.csrfToken as string;
    expect(token).toBeTruthy();

    const res = await authed
      .put('/api/admin/config')
      .set('X-CSRF-Token', token)
      .send({ PORTAL_NAME: 'Portal Dev' });
    expect([200, 204]).toContain(res.status);
  });

  it('clears admin access after logout', async () => {
    const authed = agent();
    await authed.post('/auth/login').send({ username: ADMIN_USER, password: ADMIN_PASS });
    await authed.get('/logout');
    const res = await authed.get('/api/admin/config');
    expect([401, 403, 302]).toContain(res.status);
  });
});

describe('auth rate limiting', () => {
  let app: Express;
  let db: PortalDatabase;

  beforeAll(async () => {
    process.env.AUTH_RATE_LIMIT_MAX = '5';
    process.env.COOKIE_SECURE = 'false';
    process.env.NODE_ENV = 'test';
    process.env.PORTAL_DISABLE_WEEKLY_RESTART = 'true';
    const env = loadEnv();
    const created = await createApp({ env });
    app = created.app;
    db = created.db;
  }, 60000);

  afterAll(async () => {
    await db.close();
  });

  it('rate-limits repeated auth attempts', async () => {
    const results: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'nobody', password: `wrong-${i}` });
      results.push(res.status);
    }
    expect(results.some((status) => status === 429)).toBe(true);
  });
});

describe('env validation', () => {
  it('fails when SESSION_SECRET is missing', async () => {
    const original = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    expect(() => loadEnv({ requireDatabase: false })).toThrow(/SESSION_SECRET/);
    process.env.SESSION_SECRET = original;
  });
});
