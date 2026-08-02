/** Ambient types for packages without perfect typings. */
declare module 'csrf' {
  export default class Tokens {
    secretSync(): string;
    create(secret: string): string;
    verify(secret: string, token: string): boolean;
  }
}

declare module 'web-push';

import 'express-session';

declare module 'express-session' {
  interface SessionData {
    user?: Record<string, unknown>;
    csrfSecret?: string;
  }
}
