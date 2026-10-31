const UPSTREAM_BASE_URL = (
  process.env.IPEM_UPSTREAM_URL ||
  process.env.VITE_API_BASE_URL ||
  'http://localhost:9000'
).replace(/\/+$/, '');

const DEFAULT_UPSTREAM_TIMEOUT_MS = 900000;
const UPSTREAM_TIMEOUT_MS = Number.parseInt(
  process.env.IPEM_PROXY_TIMEOUT_MS || `${DEFAULT_UPSTREAM_TIMEOUT_MS}`,
  10
);

function buildUpstreamUrl(req) {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');
  const pathValue = requestUrl.searchParams.get('path') || '';

  // Preserve the trailing slash — the backend has explicit routes for
  // /preview/html/:program_name/ (with slash) and uses redirect for the
  // no-slash variant. Without this, a path like "preview/html/prog/" loses
  // its trailing slash and triggers a 301 redirect whose Location header the
  // proxy would forward as-is, breaking the browser's ability to follow it.
  const hasTrailingSlash = pathValue.endsWith('/');
  const normalizedPath =
    pathValue
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(decodeURIComponent(segment))) // safe-encode
      .join('/') + (hasTrailingSlash && pathValue.length > 1 ? '/' : '');

  requestUrl.searchParams.delete('path');
  const query = requestUrl.searchParams.toString();
  return `${UPSTREAM_BASE_URL}/${normalizedPath}${query ? `?${query}` : ''}`;
}

function buildRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (req.body == null) return undefined;
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') return req.body;
  if (typeof req.body === 'object') return JSON.stringify(req.body);
  return undefined;
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');
  const pathValue = requestUrl.searchParams.get('path') || '';
  if (pathValue === 'backend-info') {
    return writeJson(res, 200, {
      backend_url: UPSTREAM_BASE_URL
    });
  }

  const upstreamUrl = buildUpstreamUrl(req);
  const headers = {
    'ngrok-skip-browser-warning': 'true'
  };

  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  // Forward range header for partial content / asset byte-range requests
  if (req.headers['range']) headers['range'] = req.headers['range'];

  const timeoutMs = Number.isFinite(UPSTREAM_TIMEOUT_MS) && UPSTREAM_TIMEOUT_MS > 0
    ? UPSTREAM_TIMEOUT_MS
    : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: buildRequestBody(req),
      // Use 'follow' instead of 'manual' so redirects from the backend (e.g.
      // the trailing-slash 301 redirect) are automatically followed server-side.
      // Previously 'manual' forwarded the raw 301 with a relative Location header
      // that the browser resolved to the wrong base URL.
      redirect: 'follow',
      signal: controller.signal
    });
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return writeJson(res, timedOut ? 504 : 502, {
      error: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
      message: timedOut
        ? `Upstream backend did not respond within ${timeoutMs}ms.`
        : 'Could not reach upstream backend.',
      upstream: UPSTREAM_BASE_URL
    });
  } finally {
    clearTimeout(timeout);
  }

  res.statusCode = upstreamResponse.status;

  const contentType = upstreamResponse.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);

  const cacheControl = upstreamResponse.headers.get('cache-control');
  if (cacheControl) res.setHeader('cache-control', cacheControl);

  const location = upstreamResponse.headers.get('location');
  if (location) res.setHeader('location', location);

  const setCookie = upstreamResponse.headers.get('set-cookie');
  if (setCookie) res.setHeader('set-cookie', setCookie);

  // Forward Accept-Ranges so the browser knows byte-range requests are supported
  const acceptRanges = upstreamResponse.headers.get('accept-ranges');
  if (acceptRanges) res.setHeader('accept-ranges', acceptRanges);

  const body = Buffer.from(await upstreamResponse.arrayBuffer());
  res.end(body);
};
