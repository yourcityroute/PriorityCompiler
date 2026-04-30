/**
 * STL Forestry Priority Compiler — CORS Proxy Worker
 *
 * Deploys to: a free *.workers.dev URL (e.g. stl-forestry-proxy.YOURNAME.workers.dev)
 *
 * Purpose:
 *   1. Add CORS headers to city-of-STL endpoints that don't allow browser fetches
 *   2. Inject the CSB API key server-side so it never reaches the user's browser
 *   3. Whitelist a fixed set of upstream hosts so the proxy can't be abused
 *      to fetch arbitrary URLs
 *
 * Required Worker secrets (set with `wrangler secret put`):
 *   CSB_API_KEY — your approved Open311 key from the City of St. Louis
 *
 * Optional environment variables (set in wrangler.toml or dashboard):
 *   ALLOWED_ORIGIN — exact origin allowed to call this worker
 *                    (default "*" lets anyone use it; set to your Pages URL
 *                    once deployed, e.g. "https://yourname.github.io")
 *
 * Routes the worker handles:
 *   GET /csb/services.json
 *   GET /csb/requests.json?...     (key auto-injected)
 *   GET /vbd/all                   (vacant building list)
 *   GET /vbd/detail?parcelId=...   (vacant building detail)
 *   GET /vbd/overview              (parcel-id-keyed VBD list)
 *   GET /address/lookup?address=... (per-address city lookup)
 *   GET /health                    (returns ok, used to test the worker)
 *
 * Anything else returns 404.
 */

const UPSTREAM = {
  csbBase:     'https://www.stlouis-mo.gov/powernap/stlouis/api.cfm',
  vbdAll:      'https://www.stlcitypermits.com/API/VacantBuilding/GetAllVacantBuildings',
  vbdDetail:   'https://www.stlcitypermits.com/API/VacantBuilding/GetVacantBuildingDetail',
  vbdOverview: 'https://www.stlcitypermits.com/API/VacantBuilding/GetVacantBuildingOverview',
  addrLookup:  'https://www.stlouis-mo.gov/data/address-search/index.cfm',
};

// Brief in-memory caching to be polite to upstream during a busy session.
// Worker instances are short-lived, so this is best-effort, not authoritative.
const CACHE_TTL_MS = {
  '/csb/services.json': 6 * 60 * 60 * 1000, // 6h — service list rarely changes
  '/csb/requests.json': 60 * 1000,          // 1m — request feed is real-time
  '/vbd/all':           15 * 60 * 1000,     // 15m
  '/vbd/overview':      15 * 60 * 1000,     // 15m
  '/vbd/detail':        5 * 60 * 1000,      // 5m
  '/address/lookup':    10 * 60 * 1000,     // 10m per address
};
const memCache = new Map(); // key -> { until: ms, body: string, type: string }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Only GET supported' }, 405, allowedOrigin);
    }

    const path = url.pathname.replace(/\/+$/, ''); // strip trailing slashes

    try {
      switch (path) {
        case '/health':
          return json({ ok: true, time: new Date().toISOString() }, 200, allowedOrigin);

        case '/csb/services.json':
          return await proxyJson(buildCsbUrl(env, '/services.json', url.search), path, allowedOrigin);

        case '/csb/requests.json':
          return await proxyJson(buildCsbUrl(env, '/requests.json', url.search), path, allowedOrigin);

        case '/vbd/all':
          return await proxyJson(UPSTREAM.vbdAll, path, allowedOrigin);

        case '/vbd/overview':
          return await proxyJson(UPSTREAM.vbdOverview, path, allowedOrigin);

        case '/vbd/detail': {
          const parcelId = url.searchParams.get('parcelId');
          if (!parcelId) return json({ error: 'parcelId required' }, 400, allowedOrigin);
          const target = `${UPSTREAM.vbdDetail}?parcelId=${encodeURIComponent(parcelId)}`;
          return await proxyJson(target, `/vbd/detail?${parcelId}`, allowedOrigin);
        }

        case '/address/lookup': {
          const addr = url.searchParams.get('address');
          if (!addr) return json({ error: 'address required' }, 400, allowedOrigin);
          // The city's address-search page returns HTML, not JSON — we proxy
          // the raw HTML and let the browser parse it. Caches per address.
          const target = `${UPSTREAM.addrLookup}?address=${encodeURIComponent(addr)}`;
          return await proxyHtml(target, `/address/lookup?${addr}`, allowedOrigin);
        }

        default:
          return json({ error: 'Not found', path }, 404, allowedOrigin);
      }
    } catch (e) {
      return json({ error: 'Proxy error', message: String(e && e.message || e) }, 502, allowedOrigin);
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCsbUrl(env, suffix, incomingSearch) {
  const apiKey = env.CSB_API_KEY;
  if (!apiKey) throw new Error('CSB_API_KEY secret is not configured on this worker');

  // Preserve every incoming query param except api_key (we always inject our own)
  const params = new URLSearchParams(incomingSearch);
  params.delete('api_key');
  params.set('api_key', apiKey);

  return `${UPSTREAM.csbBase}${suffix}?${params.toString()}`;
}

async function proxyJson(target, cacheKey, allowedOrigin) {
  const cached = readCache(cacheKey);
  if (cached) return rawResponse(cached.body, 200, cached.type, allowedOrigin, true);

  const upstream = await fetch(target, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'STL-Forestry-Proxy/1.0' },
    cf: { cacheTtl: 60, cacheEverything: false },
  });
  const body = await upstream.text();
  const type = upstream.headers.get('content-type') || 'application/json';

  if (upstream.ok) writeCache(cacheKey, body, type);
  return rawResponse(body, upstream.status, type, allowedOrigin, false);
}

async function proxyHtml(target, cacheKey, allowedOrigin) {
  const cached = readCache(cacheKey);
  if (cached) return rawResponse(cached.body, 200, cached.type, allowedOrigin, true);

  const upstream = await fetch(target, {
    headers: { 'Accept': 'text/html', 'User-Agent': 'STL-Forestry-Proxy/1.0' },
  });
  const body = await upstream.text();
  const type = upstream.headers.get('content-type') || 'text/html';

  if (upstream.ok) writeCache(cacheKey, body, type);
  return rawResponse(body, upstream.status, type, allowedOrigin, false);
}

function readCache(key) {
  const ttlKey = '/' + key.split('?')[0].split('/').slice(1, 3).join('/');
  const ttl = CACHE_TTL_MS[ttlKey];
  if (!ttl) return null;
  const hit = memCache.get(key);
  if (!hit) return null;
  if (hit.until < Date.now()) { memCache.delete(key); return null; }
  return hit;
}

function writeCache(key, body, type) {
  const ttlKey = '/' + key.split('?')[0].split('/').slice(1, 3).join('/');
  const ttl = CACHE_TTL_MS[ttlKey];
  if (!ttl) return;
  // Prevent unbounded growth — soft cap at 200 entries.
  if (memCache.size > 200) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(key, { until: Date.now() + ttl, body, type });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, allowedOrigin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(allowedOrigin),
    },
  });
}

function rawResponse(body, status, type, allowedOrigin, fromCache) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': type,
      'X-Proxy-Cache': fromCache ? 'HIT' : 'MISS',
      ...corsHeaders(allowedOrigin),
    },
  });
}
