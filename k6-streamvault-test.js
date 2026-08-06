/**
 * StreamVault — Grafana k6 Load Test Script
 *
 * Tests all public API endpoints with realistic traffic patterns.
 * Auth-required endpoints are tested separately (provide AUTH_TOKEN).
 *
 * Usage in Grafana Cloud k6:
 *   1. Set BASE_URL to your deployed site URL
 *   2. Set AUTH_TOKEN (optional) for authenticated endpoint tests
 *   3. Adjust stages / VUs for your test profile
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'https://your-streamvault-url.com';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

// ─── Custom Metrics ───────────────────────────────────────────────────────────

const apiLatency = new Trend('api_latency_ms');
const errorRate = new Rate('api_error_rate');
const corsPreflightTime = new Trend('cors_preflight_ms');

// ─── Common Headers ───────────────────────────────────────────────────────────

const defaultHeaders = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': 'StreamVault-k6-Test/1.0',
};

const authHeaders = AUTH_TOKEN
  ? { ...defaultHeaders, 'Authorization': `Bearer ${AUTH_TOKEN}` }
  : defaultHeaders;

// ─── Test Data ────────────────────────────────────────────────────────────────

// Well-known TMDB IDs for testing
const TEST_MOVIE_ID = 550;        // Fight Club
const TEST_TV_ID = 1396;          // Breaking Bad
const TEST_GENRE_ID = 28;         // Action
const TEST_SEARCH_QUERY = 'Inception';

// Embed URL for testing (vidapi domain is in allowlist)
const TEST_EMBED_URL = encodeURIComponent(`https://vidapi.ru/embed/movie/${TEST_MOVIE_ID}`);

// CDN URL for proxy testing (TMDB image CDN is in allowlist)
const TEST_CDN_URL = encodeURIComponent('https://image.tmdb.org/t/p/w500/8b8R8l88Qje9dn9OE8PY05Nez7S.jpg');

// ─── Options ──────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    // Ramp up: simulates users arriving on the site
    browse_content: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m', target: 30 },
        { duration: '2m', target: 50 },
        { duration: '1m', target: 50 },
        { duration: '30s', target: 0 },
      ],
      exec: 'browseFlow',
      tags: { scenario: 'browse' },
    },

    // Spike test: simulates sudden traffic burst
    spike_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 5 },
        { duration: '30s', target: 100 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 0 },
      ],
      exec: 'stressFlow',
      tags: { scenario: 'spike' },
    },

    // Steady state: sustained normal traffic
    steady_state: {
      executor: 'constant-vus',
      vus: 15,
      duration: '3m',
      exec: 'browseFlow',
      tags: { scenario: 'steady' },
    },
  },

  thresholds: {
    // Global error rate must stay below 5%
    'api_error_rate': ['rate<0.05'],
    // 95% of API responses under 3s
    'http_req_duration{endpoint:content}': ['p(95)<3000'],
    // 95% of search responses under 2s
    'http_req_duration{endpoint:search}': ['p(95)<2000'],
    // 95% of config responses under 500ms
    'http_req_duration{endpoint:config}': ['p(95)<500'],
    // 95% of source responses under 15s (heavy upstream calls)
    'http_req_duration{endpoint:source}': ['p(95)<15000'],
    // 95% of CORS preflight under 100ms
    'cors_preflight_ms': ['p(95)<100'],
  },
};

// ─── Helper: Make and validate request ───────────────────────────────────────

function makeRequest(method, path, params = {}, body = null, headers = defaultHeaders, tags = {}) {
  const url = params && Object.keys(params).length > 0
    ? `${BASE_URL}${path}?${new URLSearchParams(params).toString()}`
    : `${BASE_URL}${path}`;

  const endpointTag = tags.endpoint || 'other';
  const allTags = { endpoint: endpointTag, ...tags };

  let res;
  if (body) {
    res = http.request(method, url, JSON.stringify(body), { headers, tags: allTags });
  } else {
    res = http.request(method, url, null, { headers, tags: allTags });
  }

  apiLatency.add(res.timings.duration, allTags);
  errorRate.add(res.status >= 400 ? 1 : 0, allTags);

  return res;
}

// ─── Flow 1: Browse (simulates typical user browsing) ────────────────────────

export function browseFlow() {
  group('App Config', () => {
    const res = makeRequest('GET', '/api/config', {}, null, defaultHeaders, { endpoint: 'config' });
    check(res, {
      'config: status 200': (r) => r.status === 200,
      'config: has supabaseUrl': (r) => {
        try { return JSON.parse(r.body).supabaseUrl !== undefined; } catch { return false; }
      },
      'config: has tmdbConfigured': (r) => {
        try { return JSON.parse(r.body).tmdbConfigured !== undefined; } catch { return false; }
      },
    });
  });

  group('Content Discovery', () => {
    const contentEndpoints = [
      { path: '/api/stream/trending', params: { page: '1', type: 'all' }, name: 'trending' },
      { path: '/api/stream/popular', params: { page: '1', type: 'movie' }, name: 'popular-movies' },
      { path: '/api/stream/popular', params: { page: '1', type: 'tv' }, name: 'popular-tv' },
      { path: '/api/stream/top-rated', params: { page: '1', type: 'movie' }, name: 'top-rated' },
      { path: '/api/stream/new-releases', params: {}, name: 'new-releases' },
      { path: '/api/stream/genres', params: { type: 'movie' }, name: 'genres-movie' },
      { path: '/api/stream/genres', params: { type: 'tv' }, name: 'genres-tv' },
    ];

    for (const ep of contentEndpoints) {
      const res = makeRequest('GET', ep.path, ep.params, null, defaultHeaders, { endpoint: 'content' });
      check(res, {
        [`${ep.name}: status 200`]: (r) => r.status === 200,
        [`${ep.name}: valid JSON`]: (r) => {
          try { JSON.parse(r.body); return true; } catch { return false; }
        },
      });
    }
  });

  group('Genre Browse', () => {
    const genres = [28, 35, 18, 878]; // Action, Comedy, Drama, Sci-Fi
    for (const genreId of genres) {
      const res = makeRequest('GET', `/api/stream/genre/${genreId}`, { page: '1', type: 'movie' }, null, defaultHeaders, { endpoint: 'content' });
      check(res, {
        [`genre-${genreId}: status 200`]: (r) => r.status === 200,
      });
    }
  });

  group('Search', () => {
    const res = makeRequest('GET', '/api/stream/search', { q: TEST_SEARCH_QUERY, page: '1' }, null, defaultHeaders, { endpoint: 'search' });
    check(res, {
      'search: status 200': (r) => r.status === 200,
      'search: has results': (r) => {
        try { return JSON.parse(r.body).results !== undefined; } catch { return false; }
      },
    });
  });

  group('Content Detail', () => {
    // Movie detail
    const movieRes = makeRequest('GET', `/api/stream/detail/${TEST_MOVIE_ID}`, { type: 'movie' }, null, defaultHeaders, { endpoint: 'content' });
    check(movieRes, {
      'movie-detail: status 200': (r) => r.status === 200,
      'movie-detail: has title': (r) => {
        try { return typeof JSON.parse(r.body).title === 'string'; } catch { return false; }
      },
    });

    // TV detail
    const tvRes = makeRequest('GET', `/api/stream/detail/${TEST_TV_ID}`, { type: 'tv' }, null, defaultHeaders, { endpoint: 'content' });
    check(tvRes, {
      'tv-detail: status 200': (r) => r.status === 200,
    });

    // Season episodes
    const seasonRes = makeRequest('GET', `/api/stream/season/${TEST_TV_ID}/1`, {}, null, defaultHeaders, { endpoint: 'content' });
    check(seasonRes, {
      'season-episodes: status 200': (r) => r.status === 200,
      'season-episodes: has episodes': (r) => {
        try { return Array.isArray(JSON.parse(r.body).episodes); } catch { return false; }
      },
    });
  });

  group('Stream Source', () => {
    const res = makeRequest('GET', '/api/stream/source', {
      id: String(TEST_MOVIE_ID),
      type: 'movie',
      season: '1',
      episode: '1',
    }, null, defaultHeaders, { endpoint: 'source' });
    check(res, {
      'source: status 200': (r) => r.status === 200,
      'source: has embedUrl': (r) => {
        try { return typeof JSON.parse(r.body).embedUrl === 'string'; } catch { return false; }
      },
      'source: has fallbackUrls': (r) => {
        try { return Array.isArray(JSON.parse(r.body).fallbackUrls); } catch { return false; }
      },
    });
  });

  group('Catalog Endpoints', () => {
    const catalogs = [
      { path: '/api/stream/catalog/movies', name: 'catalog-movies' },
      { path: '/api/stream/catalog/tvshows', name: 'catalog-tvshows' },
      { path: '/api/stream/catalog/episodes', name: 'catalog-episodes' },
    ];

    for (const cat of catalogs) {
      const res = makeRequest('GET', cat.path, { page: '1' }, null, defaultHeaders, { endpoint: 'content' });
      check(res, {
        [`${cat.name}: status 200`]: (r) => r.status === 200,
      });
    }
  });

  group('CORS Preflight', () => {
    const corsPaths = [
      '/api/stream/trending',
      '/api/stream/search',
      '/api/stream/detail/550',
      '/api/stream/source',
    ];

    for (const path of corsPaths) {
      const res = http.options(`${BASE_URL}${path}`, null, { tags: { endpoint: 'cors' } });
      corsPreflightTime.add(res.timings.duration);
      check(res, {
        [`cors ${path}: 204`]: (r) => r.status === 204 || r.status === 200,
      });
    }
  });

  group('Main Page Load', () => {
    const res = http.get(BASE_URL, { tags: { endpoint: 'page' } });
    check(res, {
      'main-page: status 200': (r) => r.status === 200,
      'main-page: has HTML': (r) => r.body.includes('<!') || r.body.includes('<html') || r.body.includes('<div'),
    });
  });

  // Simulate think time between user actions
  sleep(1);
}

// ─── Flow 2: Stress (aggressive, hits heavy endpoints) ──────────────────────

export function stressFlow() {
  group('Stress: Search + Source (heavy)', () => {
    // Rapid searches with random queries
    const queries = ['Inception', 'Batman', 'Avengers', 'Matrix', 'Interstellar', 'Dune', 'Oppenheimer'];

    for (const q of queries) {
      const res = makeRequest('GET', '/api/stream/search', { q, page: '1' }, null, defaultHeaders, { endpoint: 'search' });
      check(res, {
        [`stress-search "${q}": status 200`]: (r) => r.status === 200,
      });
    }

    // Rapid source lookups
    const movieIds = [550, 12, 155, 680, 13, 603, 157336];
    for (const id of movieIds) {
      const res = makeRequest('GET', '/api/stream/source', {
        id: String(id),
        type: 'movie',
        season: '1',
        episode: '1',
      }, null, defaultHeaders, { endpoint: 'source' });
      check(res, {
        [`stress-source ${id}: status 200`]: (r) => r.status === 200,
      });
    }
  });

  group('Stress: Config spam (should be fast)', () => {
    for (let i = 0; i < 10; i++) {
      const res = makeRequest('GET', '/api/config', {}, null, defaultHeaders, { endpoint: 'config' });
      check(res, {
        [`stress-config-${i}: status 200`]: (r) => r.status === 200,
      });
    }
  });

  group('Stress: Content endpoints burst', () => {
    const pages = [1, 2, 3];
    const types = ['movie', 'tv'];

    for (const page of pages) {
      for (const type of types) {
        makeRequest('GET', '/api/stream/popular', { page: String(page), type }, null, defaultHeaders, { endpoint: 'content' });
        makeRequest('GET', '/api/stream/top-rated', { page: String(page), type }, null, defaultHeaders, { endpoint: 'content' });
        makeRequest('GET', '/api/stream/trending', { page: String(page), type }, null, defaultHeaders, { endpoint: 'content' });
      }
    }
  });

  // Minimal think time for stress test
  sleep(0.2);
}

// ─── Flow 3: Auth (only runs if AUTH_TOKEN is provided) ─────────────────────

export function authFlow() {
  if (!AUTH_TOKEN) {
    return; // Skip auth tests if no token provided
  }

  group('Auth: Session Management', () => {
    // Register session
    const sessionRes = makeRequest('POST', '/api/auth/session', {}, {
      session_id: `k6-test-${__VU}-${Date.now()}`,
      device_info: 'k6-load-test',
      force: false,
      heartbeat: false,
    }, authHeaders, { endpoint: 'auth' });
    check(sessionRes, {
      'session: status 200': (r) => r.status === 200,
      'session: has active field': (r) => {
        try { return 'active' in JSON.parse(r.body); } catch { return false; }
      },
    });

    // Heartbeat
    const heartbeatRes = makeRequest('POST', '/api/auth/session', {}, {
      session_id: `k6-test-${__VU}-${Date.now()}`,
      device_info: 'k6-load-test',
      heartbeat: true,
    }, authHeaders, { endpoint: 'auth' });

    // Get watchlist
    const watchlistRes = makeRequest('GET', '/api/watchlist', {}, null, authHeaders, { endpoint: 'watchlist' });
    check(watchlistRes, {
      'watchlist: status 200 or 401': (r) => r.status === 200 || r.status === 401,
    });
  });

  group('Auth: Users', () => {
    const usersRes = makeRequest('GET', '/api/users', {}, null, authHeaders, { endpoint: 'users' });
    check(usersRes, {
      'users: status 200 or 401': (r) => r.status === 200 || r.status === 401,
    });
  });

  sleep(1);
}
