(function initIpemConfig(global) {
  const DEFAULT_API_BASE_URL = '/api';
  const DEFAULT_REQUEST_HEADERS = Object.freeze({
    'ngrok-skip-browser-warning': '1'
  });

  function normalizeBaseUrl(value) {
    return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  }

  function getConfiguredApiBaseUrl() {
    return normalizeBaseUrl(
      global.VITE_API_BASE_URL ||
      global.__IPEM_API_BASE_URL__ ||
      global.__ENV__?.VITE_API_BASE_URL
    );
  }

  function resolveApiBaseUrl() {
    const isLocalhost = ['localhost', '127.0.0.1'].includes(global.location.hostname);
    if (isLocalhost) {
      return normalizeBaseUrl(global.localStorage.getItem('ipem_api_base')) || 'http://localhost:9000';
    }

    const queryBase = normalizeBaseUrl(new URLSearchParams(global.location.search).get('api_base'));
    if (queryBase) return queryBase;

    return getConfiguredApiBaseUrl() || DEFAULT_API_BASE_URL;
  }

  global.IPEM_CONFIG = Object.freeze({
    DEFAULT_API_BASE_URL,
    GOOGLE_CLIENT_ID: global.__IPEM_GOOGLE_CLIENT_ID__ || '',
    DEFAULT_REQUEST_HEADERS,
    API_BASE_URL: resolveApiBaseUrl()
  });
})(window);
