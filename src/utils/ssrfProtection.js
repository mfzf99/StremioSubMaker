/**
 * SSRF (Server-Side Request Forgery) protection utilities
 * 
 * Prevents custom provider baseUrls from targeting internal/private networks
 * unless explicitly allowed via ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true
 */

const log = require('./logger');

// Environment variable to allow internal endpoints (for self-hosters)
const ALLOW_INTERNAL = process.env.ALLOW_INTERNAL_CUSTOM_ENDPOINTS === 'true';

/**
 * Private/internal IP ranges that should be blocked by default
 * Covers: localhost, private networks (RFC 1918), link-local, loopback
 */
const INTERNAL_PATTERNS = [
    // IPv4 loopback
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    // IPv4 private networks (RFC 1918)
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,          // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,  // 172.16.0.0/12
    /^192\.168\.\d{1,3}\.\d{1,3}$/,              // 192.168.0.0/16
    // IPv4 link-local
    /^169\.254\.\d{1,3}\.\d{1,3}$/,             // 169.254.0.0/16
    // IPv4 shared address space (carrier-grade NAT)
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/,  // 100.64.0.0/10
];

// Hostnames that should be blocked by default
const INTERNAL_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'local',
    '127.0.0.1',
    '::1',
    '0.0.0.0'
]);

/**
 * Check if a hostname or IP is internal/private
 * @param {string} host - Hostname or IP address
 * @returns {boolean} - True if internal/private
 */
function isInternalHost(host) {
    if (!host) return true;  // Empty host is suspicious

    const lowercaseHost = host.toLowerCase();

    // Check against known internal hostnames
    if (INTERNAL_HOSTNAMES.has(lowercaseHost)) {
        return true;
    }

    // Check against private IP patterns
    for (const pattern of INTERNAL_PATTERNS) {
        if (pattern.test(host)) {
            return true;
        }
    }

    // Check for IPv6 localhost variations
    if (lowercaseHost.startsWith('[::1]') || lowercaseHost === '::1') {
        return true;
    }

    // Check for .local, .internal, .localhost TLDs
    if (lowercaseHost.endsWith('.local') ||
        lowercaseHost.endsWith('.internal') ||
        lowercaseHost.endsWith('.localhost')) {
        return true;
    }

    return false;
}

/**
 * Validate a baseUrl for SSRF safety
 * Blocks internal/private IPs and hostnames unless ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true
 * 
 * @param {string} baseUrl - The baseUrl to validate
 * @returns {{ valid: boolean, error?: string, sanitized?: string }} - Validation result
 */
function validateCustomBaseUrl(baseUrl) {
    // Empty URL is considered invalid but not an SSRF risk
    if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
        return { valid: false, error: 'Base URL is required for custom provider' };
    }

    const trimmed = baseUrl.trim();

    // Parse the URL
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (e) {
        return { valid: false, error: `Invalid URL format: ${trimmed}` };
    }

    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { valid: false, error: `Invalid protocol: ${parsed.protocol}. Only http and https are allowed.` };
    }

    const hostname = parsed.hostname;

    // Check if hostname is internal/private
    if (isInternalHost(hostname)) {
        if (ALLOW_INTERNAL) {
            log.debug(() => `[SSRF] Allowing internal endpoint ${hostname} (ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true)`);
            return { valid: true, sanitized: trimmed };
        }

        log.warn(() => `[SSRF] Blocked internal endpoint: ${hostname}. Set ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true in .env to allow local endpoints.`);
        return {
            valid: false,
            error: `Internal/private endpoints (${hostname}) are blocked on this server for security. This server is configured for public deployment.`
        };
    }

    log.debug(() => `[SSRF] Validated external endpoint: ${hostname}`);
    return { valid: true, sanitized: trimmed };
}

/**
 * Check if internal endpoints are allowed (for UI feedback)
 * @returns {boolean}
 */
function areInternalEndpointsAllowed() {
    return ALLOW_INTERNAL;
}

module.exports = {
    validateCustomBaseUrl,
    isInternalHost,
    areInternalEndpointsAllowed
};
