import type { PortalDatabase } from './db';

let _db: PortalDatabase | null = null;
export function setDb(database: PortalDatabase): void { _db = database; }
export function getDb(): PortalDatabase {
  if (!_db) throw new Error('Database has not been initialised');
  return _db;
}

export const portalSettings = new Map<string, string>();
export const EMBY_STATS_CACHE = new Map<string, unknown>();
export const OPDS_AUTH_CACHE = new Map<string, unknown>();

let _settingsReady: Promise<void> = Promise.resolve();
export function setSettingsReady(p: Promise<void>): void { _settingsReady = p; }
export function getSettingsReady(): Promise<void> { return _settingsReady; }
