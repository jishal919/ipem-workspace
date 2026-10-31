// web/sw.js
// ─── IPEM SERVICE WORKER FOR PREVIEW VIRTUALIZATION ─────────────────────────
//
// VERSION: 4 (2026-07-18)
//
// This Service Worker intercepts all requests under '/proxy-preview/*' and
// forwards them to the appropriate backend endpoint, handling two environments:
//
// ── PRODUCTION (Vercel / non-localhost) ─────────────────────────────────────
//   The target URL decoded from the proxy path is a cross-origin URL (ngrok,
//   custom domain, etc.). The Service Worker MUST NOT fetch this directly:
//   the browser enforces CORS rules and any CORS preflight failure or missing
//   ACAO header causes TypeError "Failed to fetch".
//
//   Fix: rewrite the fetch to the same-origin Vercel /api/* serverless proxy.
//   The proxy runs server-side (no CORS restrictions) and forwards the request
//   to the ngrok backend, injecting ngrok-skip-browser-warning as needed.
//
// ── LOCAL DEVELOPMENT (localhost) ────────────────────────────────────────────
//   The SW fetches directly to http://localhost:9000 with a clean header set.
//   This is cross-origin (different port) but the localhost backend has CORS
//   configured to allow http://localhost:3000 and the fetch works correctly.
//
// VERSIONING:
//   Bump SW_VERSION on every change. Combined with updateViaCache:'none' in
//   the registration, this forces all browser clients to pick up the new SW
//   automatically on the next page load — no manual unregister required.

const SW_VERSION = 5;

const PROXY_PREFIX = '/proxy-preview/';
const PREVIEW_HTML_PREFIX = '/preview/html/';

// Map of preview base path -> token for sub-resource authentication.
// Keyed by the program's preview base path, e.g.:
//   '/preview/html/basic_calculator_1234567890/'
// The main HTML request (with ?token=) populates this; CSS/JS/image
// sub-resource requests (no token) look the token up here.
const tokenCache = {};

self.addEventListener('install', (event) => {
  console.log(`[SW v${SW_VERSION}] Installing...`);
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log(`[SW v${SW_VERSION}] Activating and claiming clients...`);
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // ── Handle proxy-preview requests (existing logic) ─────────────────────────
  if (url.pathname.startsWith(PROXY_PREFIX)) {
    event.respondWith(handleProxyRequest(event.request, url));
    return;
  }

  // ── Handle direct /preview/html/ sub-resource requests ────────────────────
  // When an iframe loads index.html with ?token=X, the browser makes subsequent
  // requests for style.css / script.js WITHOUT the token. The SW intercepts
  // those sub-resource requests and injects the cached token.
  if (url.pathname.startsWith(PREVIEW_HTML_PREFIX)) {
    event.respondWith(handleHtmlPreviewSubresource(event.request, url));
  }
});

/**
 * Intercepts /preview/html/<program>/<asset> requests.
 * - If ?token= is present: cache it keyed by program base path, then pass through.
 * - If ?token= is absent: inject it from cache and pass through.
 * Requests from inside the iframe for CSS/JS/images fall into the "absent" case.
 */
async function handleHtmlPreviewSubresource(request, url) {
  // Derive the base key: /preview/html/<program_name>/
  const parts = url.pathname.split('/');
  // parts: ['', 'preview', 'html', '<program_name>', ...rest]
  const programName = parts[3];
  if (!programName) return fetch(request);
  const baseKey = `${PREVIEW_HTML_PREFIX}${programName}/`;

  let token = url.searchParams.get('token');

  if (token) {
    // Cache token for this program
    tokenCache[baseKey] = token;
    // Pass through as-is (token already present)
    return fetch(request);
  } else {
    // Sub-resource request without token — inject cached token
    token = tokenCache[baseKey];
    if (token) {
      const newUrl = new URL(url.toString());
      newUrl.searchParams.set('token', token);
      const newRequest = new Request(newUrl.toString(), {
        method: request.method,
        headers: request.headers,
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: request.redirect,
      });
      return fetch(newRequest);
    }
    // No cached token — pass through and let the server decide
    return fetch(request);
  }
}

async function handleProxyRequest(request, url) {
  // ── Step 1: Parse the proxy URL ───────────────────────────────────────────
  // Format: /proxy-preview/{encodedBaseUrl}/{filepath}?{query}
  const remaining = url.pathname.slice(PROXY_PREFIX.length);
  const firstSlash = remaining.indexOf('/');

  let encodedBaseUrl = remaining;
  let filepath = '';
  if (firstSlash !== -1) {
    encodedBaseUrl = remaining.slice(0, firstSlash);
    filepath = remaining.slice(firstSlash + 1);
  }

  let decodedBaseUrl;
  try {
    decodedBaseUrl = decodeURIComponent(encodedBaseUrl);
  } catch (e) {
    return new Response('Invalid encoded base URL: ' + e.message, { status: 400 });
  }

  // Normalise base URL to always end with a slash (used as cache key)
  const baseUrlWithSlash = decodedBaseUrl.endsWith('/') ? decodedBaseUrl : decodedBaseUrl + '/';

  // Construct the actual upstream URL: base + filepath + query string from proxy URL
  const targetUrl = new URL(baseUrlWithSlash + filepath + url.search);

  // ── Step 2: Auth token caching ────────────────────────────────────────────
  // The first request (main HTML) carries ?token=… in the query string.
  // Subsequent sub-resource requests (CSS, JS, images) don't carry the token.
  // We cache it keyed by the base URL and reattach it for sub-resources.
  let token = targetUrl.searchParams.get('token');
  if (token) {
    tokenCache[baseUrlWithSlash] = token;
  } else {
    token = tokenCache[baseUrlWithSlash];
    if (token) {
      targetUrl.searchParams.set('token', token);
    }
  }

  // ── Step 3: Route decision ────────────────────────────────────────────────
  const swOrigin = self.location.origin;        // e.g. https://ipem-web.vercel.app
  const targetOrigin = targetUrl.origin;         // e.g. https://ngrok.ngrok-free.app
  const isCrossOrigin = targetOrigin !== swOrigin;
  const isLocalDev = (
    self.location.hostname === 'localhost' ||
    self.location.hostname === '127.0.0.1'
  );

  // ── Route A: Production cross-origin → Vercel /api/ same-origin proxy ─────
  if (isCrossOrigin && !isLocalDev) {
    // Rewrite to /api/<path>?<query> — same-origin fetch, no CORS involved.
    // The Vercel serverless function at web/api/proxy.js proxies the request
    // server-side (with ngrok-skip-browser-warning and auth forwarding).
    const apiPath = '/api' + targetUrl.pathname + targetUrl.search;
    try {
      const response = await fetch(new URL(apiPath, swOrigin).toString());
      return response;
    } catch (err) {
      console.error(`[SW v${SW_VERSION}] Production /api proxy error for ${apiPath}:`, err);
      return new Response('Proxy fetch failed: ' + err.message, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }

  // ── Route B: Same-origin target (e.g. race condition where API_BASE is
  //             still '/api' and the base URL resolves to ipem-web.vercel.app)
  if (!isCrossOrigin) {
    try {
      const response = await fetch(targetUrl.toString());
      return response;
    } catch (err) {
      console.error(`[SW v${SW_VERSION}] Same-origin fetch error for ${targetUrl}:`, err);
      return new Response('Proxy fetch failed: ' + err.message, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }

  // ── Route C: Local development — cross-origin to localhost backend ─────────
  // Build a clean, minimal header set from scratch.
  // IMPORTANT: Do NOT copy the incoming request headers. Browsers inject
  // forbidden metadata headers (sec-fetch-mode, sec-fetch-site, sec-fetch-dest,
  // host, referer, origin, upgrade-insecure-requests, etc.) into navigations
  // and sub-resource loads. Setting these manually in a cross-origin fetch()
  // causes TypeError "Failed to fetch".
  //
  // Also do NOT add an Authorization header — the token is already in the URL
  // query params (?token=…). Adding Authorization triggers a CORS preflight.
  const headers = new Headers();
  const SAFE_TO_FORWARD = ['accept', 'accept-language', 'cache-control', 'range'];
  for (const name of SAFE_TO_FORWARD) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Add ngrok bypass header only for actual ngrok tunnel URLs
  if (
    decodedBaseUrl.includes('ngrok.io') ||
    decodedBaseUrl.includes('ngrok-free.app') ||
    decodedBaseUrl.includes('ngrok-free.dev')
  ) {
    headers.set('ngrok-skip-browser-warning', 'true');
  }

  const fetchOptions = {
    method: request.method,
    headers,
    credentials: 'omit', // token is in query params; no cookie needed
    mode: 'cors',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      fetchOptions.body = await request.blob();
    } catch (e) {
      // Body unreadable — proceed without body
    }
  }

  try {
    const response = await fetch(targetUrl.toString(), fetchOptions);
    return response;
  } catch (err) {
    console.error(`[SW v${SW_VERSION}] Local fetch error for ${targetUrl}:`, err);
    return new Response('Proxy fetch failed: ' + err.message, {
      status: 502,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}
