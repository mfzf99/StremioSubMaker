/**
 * Service Worker - Version-Based Cache Management
 *
 * This service worker handles:
 * 1. Version detection and cache invalidation on app updates
 * 2. Offline-first caching for static assets
 * 3. Network-first for API calls and dynamic content
 * 4. Automatic cache cleanup on version changes
 */

// Cache version from build time
let APP_VERSION = 'unknown';

// Fetch version from server on install
async function getAppVersion() {
    try {
        const response = await fetch('/api/session-stats', { cache: 'no-store' });
        const data = await response.json();
        return data.version || 'unknown';
    } catch (e) {
        return 'unknown';
    }
}

// Initialize version
getAppVersion().then(v => {
    APP_VERSION = v;
});

const CACHE_PREFIX = 'submaker';
const getVersionedCacheName = (version) => `${CACHE_PREFIX}-static-v${version}`;
const API_CACHE_NAME = `${CACHE_PREFIX}-api-v1`;

// Detect whether an API request is sensitive (contains tokens/config/session identifiers)
function isSensitiveApiRequest(urlLike) {
    const url = urlLike instanceof URL ? urlLike : new URL(urlLike, self.location.origin);

    return [
        '/api/get-session',
        '/api/update-session',
        '/api/create-session'
    ].some(path => url.pathname.startsWith(path)) ||
        url.searchParams.has('config') ||
        url.searchParams.has('token') ||
        url.pathname.includes('session');
}

// Honor server cache directives (no-store/private) when deciding to cache
function responseHasNoStore(response) {
    const cacheControl = (response.headers.get('Cache-Control') || '').toLowerCase();
    const pragma = (response.headers.get('Pragma') || '').toLowerCase();
    const surrogate = (response.headers.get('Surrogate-Control') || '').toLowerCase();

    return cacheControl.includes('no-store') ||
        cacheControl.includes('no-cache') ||
        cacheControl.includes('private') ||
        pragma.includes('no-cache') ||
        surrogate.includes('no-store');
}

// Purge any previously cached sensitive API entries so legacy data isn't retained
async function purgeSensitiveApiCacheEntries() {
    try {
        const cache = await caches.open(API_CACHE_NAME);
        const requests = await cache.keys();
        await Promise.all(requests.map(async (req) => {
            const url = new URL(req.url);

            if (isSensitiveApiRequest(url)) {
                await cache.delete(req);
                return;
            }

            const cachedResp = await cache.match(req);
            if (cachedResp && responseHasNoStore(cachedResp)) {
                await cache.delete(req);
            }
        }));
    } catch (error) {
    }
}

// Assets to cache on install
const ASSET_URLS = [
    '/',
    '/configure',
    '/config.js',
    '/configure.html',
    '/favicon.svg'
];

/**
 * Install event: Cache static assets
 */
self.addEventListener('install', (event) => {

    event.waitUntil(
        getAppVersion().then(version => {
            APP_VERSION = version;
            const cacheName = getVersionedCacheName(version);

            return caches.open(cacheName).then(cache => {
                return cache.addAll(ASSET_URLS).catch(err => {
                    // Don't fail install if some assets can't be cached
                    return Promise.resolve();
                });
            });
        })
    );

    // Skip waiting to activate immediately
    self.skipWaiting();
});

/**
 * Activate event: Clean up old cache versions
 */
self.addEventListener('activate', (event) => {

    event.waitUntil(
        (async () => {
            const currentVersion = await getAppVersion();
            APP_VERSION = currentVersion;
            const currentCacheName = getVersionedCacheName(currentVersion);

            // Delete old version caches
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames.map(cacheName => {
                    // Keep current version cache and API cache
                    if (cacheName === currentCacheName || cacheName === API_CACHE_NAME) {
                        return Promise.resolve();
                    }

                    // Delete old version caches
                    if (cacheName.startsWith(CACHE_PREFIX)) {
                        return caches.delete(cacheName);
                    }

                    return Promise.resolve();
                })
            );
            await purgeSensitiveApiCacheEntries();
        })()
    );

    // Claim clients immediately
    self.clients.claim();
});

/**
 * Fetch event: Handle requests with appropriate caching strategy
 */
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip cross-origin requests
    if (url.origin !== self.location.origin) {
        return;
    }

    // API calls: Network-first strategy
    if (url.pathname.startsWith('/api/')) {
        return event.respondWith(handleApiRequest(request));
    }

    // HTML pages: Network-first strategy
    if (url.pathname === '/' || url.pathname === '/configure' || url.pathname.endsWith('.html')) {
        return event.respondWith(handleHtmlRequest(request));
    }

    // Static assets: Cache-first strategy
    if (isStaticAsset(url.pathname)) {
        return event.respondWith(handleStaticAsset(request));
    }
});

/**
 * Handle API requests with network-first strategy
 */
async function handleApiRequest(request) {
    const isGetRequest = request.method === 'GET';
    const url = new URL(request.url);
    const isSensitiveRequest = isSensitiveApiRequest(url);

    try {
        // Always prefer fresh network data
        const fetchOptions = isSensitiveRequest ? { cache: 'no-store' } : undefined;
        const response = await fetch(request, fetchOptions);

        // Cache successful API responses (GET only) when they are safe to store
        if (response.ok && isGetRequest && !isSensitiveRequest && !responseHasNoStore(response)) {
            const cache = await caches.open(API_CACHE_NAME);
            cache.put(request, response.clone());
        }

        return response;
    } catch (error) {
        // Network failed, try cache only when the request is safe to read from cache
        if (isGetRequest && !isSensitiveRequest) {
            const cached = await caches.match(request);
            if (cached) {
                return cached;
            }
        }

        // No cache available, return error response
        return new Response(
            JSON.stringify({ error: 'Offline - no cached response available' }),
            {
                status: 503,
                statusText: 'Service Unavailable',
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

/**
 * Handle HTML requests with network-first strategy
 */
async function handleHtmlRequest(request) {
    try {
        // Always try network first for HTML (configured with no-cache headers)
        const response = await fetch(request, { cache: 'no-store' });

        if (response.ok) {
            // Check if response has no-cache headers
            const cacheControl = response.headers.get('Cache-Control');
            const shouldCache = !cacheControl || (!cacheControl.includes('no-cache') && !cacheControl.includes('no-store'));

            // Only cache HTML if it doesn't have no-cache headers
            // This ensures configure.html and config.js are always fresh
            if (shouldCache) {
                const cache = await caches.open(getVersionedCacheName(APP_VERSION));
                cache.put(request, response.clone());
            }
        }

        return response;
    } catch (error) {
        // Network failed, try cache
        const cached = await caches.match(request);
        if (cached) {
            return cached;
        }

        return new Response(
            'Offline - no cached response available',
            {
                status: 503,
                statusText: 'Service Unavailable'
            }
        );
    }
}

/**
 * Handle static assets with cache-first strategy
 */
async function handleStaticAsset(request) {
    const cacheName = getVersionedCacheName(APP_VERSION);

    // Try cache first
    const cached = await caches.match(request);
    if (cached) {
        return cached;
    }

    try {
        // Not in cache, fetch from network
        const response = await fetch(request);

        if (response.ok) {
            // Cache the response
            const cache = await caches.open(cacheName);
            cache.put(request, response.clone());
        }

        return response;
    } catch (error) {
        // Network failed and not in cache
        return new Response(
            'Offline - asset not cached',
            {
                status: 503,
                statusText: 'Service Unavailable'
            }
        );
    }
}

/**
 * Check if a path is a static asset
 */
function isStaticAsset(pathname) {
    const staticExtensions = ['.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ttf', '.eot'];
    return staticExtensions.some(ext => pathname.endsWith(ext));
}

/**
 * Message handler for cache control from clients
 */
self.addEventListener('message', (event) => {

    if (event.data && event.data.type === 'CLEAR_CACHE') {
        handleClearCache();
    } else if (event.data && event.data.type === 'GET_VERSION') {
        event.ports[0].postMessage({ version: APP_VERSION });
    }
});

/**
 * Manually clear cache when requested by client
 */
async function handleClearCache() {
    try {
        const cacheNames = await caches.keys();
        const deletePromises = cacheNames.map(cacheName => {
            if (cacheName.startsWith(CACHE_PREFIX)) {
                return caches.delete(cacheName);
            }
            return Promise.resolve();
        });

        await Promise.all(deletePromises);
    } catch (error) {
    }
}
