/**
 * Attaches X-CSRF-Token to browser fetch() calls for POST/PUT/DELETE/PATCH.
 * Token is loaded from GET /api/csrf-token (session cookie required).
 */
(function () {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if (window.__portalCsrfPatched) return;
  window.__portalCsrfPatched = true;

  let token = null;
  const load = fetch('/api/csrf-token', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (data) { token = data && data.csrfToken ? data.csrfToken : null; })
    .catch(function () { token = null; });

  const original = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    init = init ? Object.assign({}, init) : {};
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      await load;
      if (token) {
        const headers = new Headers(init.headers || {});
        if (!headers.has('X-CSRF-Token') && !headers.has('csrf-token')) {
          headers.set('X-CSRF-Token', token);
        }
        init.headers = headers;
      }
      if (!init.credentials) init.credentials = 'same-origin';
    }
    return original(input, init);
  };
})();
