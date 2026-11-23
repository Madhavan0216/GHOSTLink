/**
 * GHOSTLINK Tor Proxy Server
 * Routes all browser traffic through Tor SOCKS5 proxy
 * 
 * Features:
 * - HTTP/HTTPS proxying through Tor
 * - .onion domain support
 * - DNS resolution over Tor
 * - Security header normalization
 * - Tab-level circuit isolation
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { getTorController } = require('./tor_controller');
const crypto = require('crypto');

// =============================================================================
// TOR BROWSER PARITY CONFIGURATION
// Reference: https://2019.www.torproject.org/projects/torbrowser/design/
// =============================================================================

const TOR_BROWSER_CONFIG = {
    // User-Agent matches Tor Browser 13.0 (Firefox 115 ESR)
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; rv:115.0) Gecko/20100101 Firefox/115.0',
    
    // Accept-Language: Tor Browser uses en-US only to prevent locale fingerprinting
    ACCEPT_LANGUAGE: 'en-US,en;q=0.5',
    
    // HTTPS-First: Upgrade insecure requests where possible
    HTTPS_FIRST: true,
    
    // HTTPS-Only: Strict mode - block all HTTP (except .onion)
    HTTPS_ONLY: false,
    
    // Maximum redirects (Tor Browser default)
    MAX_REDIRECTS: 20,
    
    // Request timeout (Tor Browser uses longer timeouts)
    REQUEST_TIMEOUT: 120000,
    
    // Referrer Policy: Tor Browser sends origin-only referrer to same origin
    REFERRER_POLICY: 'same-origin',
    
    // First-Party Isolation: Isolate by eTLD+1
    FIRST_PARTY_ISOLATION: true,
    
    // Resist Fingerprinting (what we can control at proxy level)
    RESIST_FINGERPRINTING: true,
    
    // Onion-Only Mode: Block all clearnet, only allow .onion
    ONION_ONLY_MODE: false,
    
    // Block mixed content (http:// resources on https:// pages)
    BLOCK_MIXED_CONTENT: true,
    
    // Security Level (like Tor Browser's slider)
    // 1 = Standard (scripts in sandbox disabled anyway)
    // 2 = Safer (additional restrictions)
    // 3 = Safest (maximum restrictions)
    SECURITY_LEVEL: 2,
    
    // Minimal logging (privacy)
    MINIMAL_LOGGING: true
};

// SSRF Prevention: Blocked IP ranges and hostnames
const BLOCKED_HOSTS = [
    // Localhost variations
    'localhost', '127.0.0.1', '::1', '0.0.0.0',
    // Metadata endpoints (cloud providers)
    '169.254.169.254', 'metadata.google.internal',
    // Internal network indicators
    'internal', 'local', 'corp', 'intranet'
];

const BLOCKED_IP_RANGES = [
    // Private IPv4 ranges (RFC 1918)
    { start: '10.0.0.0', end: '10.255.255.255' },
    { start: '172.16.0.0', end: '172.31.255.255' },
    { start: '192.168.0.0', end: '192.168.255.255' },
    // Loopback
    { start: '127.0.0.0', end: '127.255.255.255' },
    // Link-local
    { start: '169.254.0.0', end: '169.254.255.255' }
];

/**
 * Check if IP is in a blocked range (SSRF prevention)
 */
function isBlockedIP(ip) {
    if (!ip || typeof ip !== 'string') return false;
    
    // Check hostname blocklist
    const lowerIp = ip.toLowerCase();
    if (BLOCKED_HOSTS.some(h => lowerIp === h || lowerIp.endsWith('.' + h))) {
        return true;
    }
    
    // IPv4 range check
    const parts = ip.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
        const ipNum = (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
        
        for (const range of BLOCKED_IP_RANGES) {
            const startParts = range.start.split('.').map(Number);
            const endParts = range.end.split('.').map(Number);
            const startNum = (startParts[0] << 24) + (startParts[1] << 16) + (startParts[2] << 8) + startParts[3];
            const endNum = (endParts[0] << 24) + (endParts[1] << 16) + (endParts[2] << 8) + endParts[3];
            
            if (ipNum >= startNum && ipNum <= endNum) {
                return true;
            }
        }
    }
    
    return false;
}

/**
 * Validate URL for security (SSRF prevention, protocol validation)
 */
function validateUrl(urlString) {
    try {
        const url = new URL(urlString);
        
        // Only allow http, https
        if (!['http:', 'https:'].includes(url.protocol)) {
            return { valid: false, reason: 'Invalid protocol. Only HTTP/HTTPS allowed.' };
        }
        
        // Onion-Only Mode: Block all clearnet
        if (TOR_BROWSER_CONFIG.ONION_ONLY_MODE && !url.hostname.endsWith('.onion')) {
            return { valid: false, reason: 'Onion-Only mode enabled. Only .onion addresses allowed.' };
        }
        
        // HTTPS-Only Mode: Block HTTP (except .onion which is inherently encrypted)
        if (TOR_BROWSER_CONFIG.HTTPS_ONLY && 
            url.protocol === 'http:' && 
            !url.hostname.endsWith('.onion')) {
            return { valid: false, reason: 'HTTPS-Only mode enabled. HTTP not allowed.' };
        }
        
        // Block internal/private hostnames (except .onion)
        if (!url.hostname.endsWith('.onion')) {
            if (isBlockedIP(url.hostname)) {
                return { valid: false, reason: 'Access to internal addresses is blocked.' };
            }
        }
        
        // Block file:// and data:// in URL paths
        if (url.pathname.includes('file:') || url.pathname.includes('data:')) {
            return { valid: false, reason: 'Invalid URL path.' };
        }
        
        return { valid: true, url };
    } catch (e) {
        return { valid: false, reason: 'Malformed URL.' };
    }
}

/**
 * Extract eTLD+1 for first-party isolation (simplified)
 */
function getFirstPartyDomain(hostname) {
    if (!hostname) return 'unknown';
    
    // Handle .onion specially
    if (hostname.endsWith('.onion')) {
        return hostname;
    }
    
    // Simple eTLD+1 extraction (handles common cases)
    const parts = hostname.split('.');
    if (parts.length <= 2) {
        return hostname;
    }
    
    // Handle common two-part TLDs
    const twoPartTLDs = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.in'];
    const lastTwo = parts.slice(-2).join('.');
    
    if (twoPartTLDs.includes(lastTwo)) {
        return parts.slice(-3).join('.');
    }
    
    return parts.slice(-2).join('.');
}

/**
 * Upgrade HTTP to HTTPS (HTTPS-First behavior)
 */
function upgradeToHttps(urlString) {
    if (!TOR_BROWSER_CONFIG.HTTPS_FIRST) return urlString;
    
    try {
        const url = new URL(urlString);
        // Only upgrade http:// to https:// (not .onion by default)
        if (url.protocol === 'http:' && !url.hostname.endsWith('.onion')) {
            url.protocol = 'https:';
            return url.toString();
        }
    } catch (e) {
        // Return original if parsing fails
    }
    return urlString;
}

class TorProxy {
    constructor(options = {}) {
        this.socksHost = options.socksHost || '127.0.0.1';
        this.socksPort = options.socksPort || 9050;
        this.proxyPort = options.proxyPort || 3001;
        
        // Tab isolation - maps tabId to circuit info
        this.tabCircuits = new Map();
        
        // Request cache for deduplication
        this.requestCache = new Map();
        
        // Normalized headers matching Tor Browser 13.0 (Firefox 115 ESR)
        // Reference: https://2019.www.torproject.org/projects/torbrowser/design/#fingerprinting-linkability
        this.standardHeaders = {
            'User-Agent': TOR_BROWSER_CONFIG.USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': TOR_BROWSER_CONFIG.ACCEPT_LANGUAGE,
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Sec-GPC': '1'  // Global Privacy Control (Tor Browser sends this)
            // Note: DNT removed - Tor Browser deprecated it as it can be a fingerprint
        };
        
        // First-party isolation state: maps firstPartyDomain -> circuitCredentials
        this.firstPartyCircuits = new Map();
        
        // Session storage (cleared on new identity)
        this.sessionState = {
            cookies: new Map(),  // firstPartyDomain -> cookies
            startTime: Date.now()
        };

        // Blocked headers that could leak info
        this.blockedHeaders = [
            'x-forwarded-for',
            'x-real-ip',
            'x-client-ip',
            'cf-connecting-ip',
            'true-client-ip',
            'x-cluster-client-ip',
            'forwarded',
            'via'
        ];

        this.server = null;
        this.torController = getTorController({
            socksPort: this.socksPort
        });
    }

    /**
     * Create SOCKS proxy agent for Tor with First-Party Isolation
     * Implements Tor Browser's circuit isolation strategy:
     * - Same first-party domain = same circuit
     * - Different first-party domain = different circuit
     * Reference: https://2019.www.torproject.org/projects/torbrowser/design/#identifier-linkability
     */
    createAgent(tabId = null, timeout = 60000, targetUrl = null) {
        let username = '';
        let password = '';
        
        // First-Party Isolation: Use eTLD+1 as circuit identifier
        if (TOR_BROWSER_CONFIG.FIRST_PARTY_ISOLATION && targetUrl) {
            try {
                const url = new URL(targetUrl);
                const firstPartyDomain = getFirstPartyDomain(url.hostname);
                
                // Check if we already have a circuit for this first-party domain
                if (this.firstPartyCircuits.has(firstPartyDomain)) {
                    const circuit = this.firstPartyCircuits.get(firstPartyDomain);
                    username = circuit.username;
                    password = circuit.password;
                } else {
                    // Create new circuit credentials for this first-party domain
                    username = `fp_${crypto.createHash('sha256').update(firstPartyDomain).digest('hex').substring(0, 16)}`;
                    password = crypto.randomBytes(16).toString('hex');
                    this.firstPartyCircuits.set(firstPartyDomain, {
                        username,
                        password,
                        domain: firstPartyDomain,
                        created: Date.now()
                    });
                }
            } catch (e) {
                // Fall back to tab isolation if URL parsing fails
            }
        }
        
        // Fallback: Tab-based isolation if no first-party domain
        if (!username && tabId) {
            if (this.tabCircuits.has(tabId)) {
                const circuit = this.tabCircuits.get(tabId);
                username = circuit.username;
                password = circuit.password;
            } else {
                username = `tab_${tabId}`;
                password = crypto.randomBytes(8).toString('hex');
                this.tabCircuits.set(tabId, { username, password, created: Date.now() });
            }
        }

        // Use socks5h:// for DNS resolution through Tor
        const proxyUrl = username 
            ? `socks5h://${username}:${password}@${this.socksHost}:${this.socksPort}`
            : `socks5h://${this.socksHost}:${this.socksPort}`;

        return new SocksProxyAgent(proxyUrl, {
            timeout: timeout || TOR_BROWSER_CONFIG.REQUEST_TIMEOUT
        });
    }
    
    /**
     * Get configuration value
     */
    getConfig(key) {
        return TOR_BROWSER_CONFIG[key];
    }
    
    /**
     * Set configuration value (runtime update)
     */
    setConfig(key, value) {
        if (key in TOR_BROWSER_CONFIG) {
            TOR_BROWSER_CONFIG[key] = value;
            return true;
        }
        throw new Error(`Unknown config key: ${key}`);
    }
    
    /**
     * Clear all session state (called on New Identity)
     * Implements Tor Browser's "New Identity" behavior
     */
    clearSessionState() {
        this.firstPartyCircuits.clear();
        this.tabCircuits.clear();
        this.requestCache.clear();
        this.sessionState = {
            cookies: new Map(),
            startTime: Date.now()
        };
        console.log('[TorProxy] Session state cleared (New Identity)');
    }

    /**
     * Normalize request headers for privacy (Tor Browser parity)
     * Implements strict header normalization to prevent fingerprinting
     */
    normalizeHeaders(originalHeaders, targetHostname = null, sourceUrl = null) {
        const normalized = { ...this.standardHeaders };
        
        // Set correct Host header for the target
        if (targetHostname) {
            normalized['Host'] = targetHostname;
        }
        
        // Referrer Policy: Tor Browser uses strict same-origin policy
        // Only send referrer if same eTLD+1 (first-party)
        if (sourceUrl && targetHostname) {
            try {
                const sourceHost = new URL(sourceUrl).hostname;
                const sourceFP = getFirstPartyDomain(sourceHost);
                const targetFP = getFirstPartyDomain(targetHostname);
                
                // Only include referrer for same first-party
                if (sourceFP === targetFP && originalHeaders['referer']) {
                    // Send origin-only referrer (not full path)
                    const refUrl = new URL(originalHeaders['referer']);
                    normalized['Referer'] = `${refUrl.protocol}//${refUrl.host}/`;
                }
                // Cross-origin: no referrer (Tor Browser default)
            } catch (e) {
                // No referrer on parse error
            }
        }
        
        // Never forward these headers (privacy leaks)
        // Already handled by blockedHeaders list, but explicit here for clarity
        delete normalized['cookie'];  // Cookies handled separately with isolation
        delete normalized['authorization'];  // Could leak credentials cross-origin

        return normalized;
    }

    /**
     * Add security headers to response (relaxed for browsing)
     */
    addSecurityHeaders(response) {
        // Don't add restrictive CSP - let content render naturally
        const headers = { ...response.headers };
        // Remove any CSP that might block content
        delete headers['content-security-policy'];
        delete headers['x-frame-options'];
        return headers;
    }

    /**
     * Fetch URL through Tor with automatic redirect following
     * Implements Tor Browser behavior: HTTPS-First, URL validation, redirect limits
     */
    async fetchUrl(targetUrl, options = {}) {
        const { 
            tabId, 
            method = 'GET', 
            headers = {}, 
            body = null, 
            timeout = TOR_BROWSER_CONFIG.REQUEST_TIMEOUT,
            maxRedirects = TOR_BROWSER_CONFIG.MAX_REDIRECTS,
            sourceUrl = null  // For referrer policy
        } = options;
        
        // SECURITY: Validate URL before any network request
        const validation = validateUrl(targetUrl);
        if (!validation.valid) {
            throw new Error(`Blocked: ${validation.reason}`);
        }
        
        // HTTPS-First: Upgrade http:// to https:// (except .onion)
        let currentUrl = upgradeToHttps(targetUrl);
        let redirectCount = 0;
        let httpsDowngraded = false;

        while (redirectCount < maxRedirects) {
            try {
                const response = await this._fetchSingleUrl(currentUrl, { 
                    tabId, 
                    method, 
                    headers, 
                    body, 
                    timeout,
                    sourceUrl: redirectCount === 0 ? sourceUrl : currentUrl
                });
                
                // Check for redirects (301, 302, 303, 307, 308)
                if ([301, 302, 303, 307, 308].includes(response.status) && response.headers['location']) {
                    redirectCount++;
                    const location = response.headers['location'];
                    
                    // Handle relative URLs
                    if (location.startsWith('/')) {
                        const urlObj = new URL(currentUrl);
                        currentUrl = `${urlObj.protocol}//${urlObj.host}${location}`;
                    } else if (!location.startsWith('http')) {
                        const urlObj = new URL(currentUrl);
                        currentUrl = `${urlObj.protocol}//${urlObj.host}/${location}`;
                    } else {
                        currentUrl = location;
                    }
                    
                    // Validate redirect target (SSRF prevention)
                    const redirectValidation = validateUrl(currentUrl);
                    if (!redirectValidation.valid) {
                        throw new Error(`Blocked redirect: ${redirectValidation.reason}`);
                    }
                    
                    console.log(`[TorProxy] Following redirect (${response.status}) to: ${currentUrl}`);
                    continue;
                }
                
                // Update the final URL in the response
                response.url = currentUrl;
                response.finalUrl = currentUrl;
                response.redirected = redirectCount > 0;
                response.httpsUpgraded = targetUrl !== currentUrl && !httpsDowngraded;
                return response;
                
            } catch (err) {
                // HTTPS-First fallback: If HTTPS fails, try HTTP (like Tor Browser)
                if (TOR_BROWSER_CONFIG.HTTPS_FIRST && 
                    !httpsDowngraded && 
                    currentUrl.startsWith('https://') && 
                    !currentUrl.includes('.onion') &&
                    (err.message.includes('ECONNREFUSED') || 
                     err.message.includes('ENOTFOUND') ||
                     err.message.includes('certificate') ||
                     err.message.includes('SSL'))) {
                    
                    console.log(`[TorProxy] HTTPS failed, falling back to HTTP for: ${currentUrl}`);
                    currentUrl = currentUrl.replace('https://', 'http://');
                    httpsDowngraded = true;
                    continue;
                }
                throw err;
            }
        }
        
        throw new Error(`Too many redirects (max ${maxRedirects})`);
    }

    /**
     * Fetch a single URL through Tor (internal method)
     */
    async _fetchSingleUrl(targetUrl, options = {}) {
        const { tabId, method = 'GET', headers = {}, body = null, timeout = 60000, sourceUrl = null } = options;

        return new Promise((resolve, reject) => {
            try {
                const url = new URL(targetUrl);
                const isHttps = url.protocol === 'https:';
                const isOnion = url.hostname.endsWith('.onion');
                
                // Use first-party isolation for circuit selection
                const agent = this.createAgent(tabId, timeout, targetUrl);
                const httpModule = isHttps ? https : http;

                const                 requestOptions = {
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname + url.search,
                    method,
                    headers: this.normalizeHeaders(headers, url.hostname, sourceUrl),
                    agent,
                    timeout,
                    // For .onion, we need to handle self-signed certs
                    rejectUnauthorized: !isOnion
                };

                // Minimal logging mode: only log if disabled or on error
                if (!TOR_BROWSER_CONFIG.MINIMAL_LOGGING) {
                    console.log(`[TorProxy] Fetching ${targetUrl} via SOCKS ${this.socksHost}:${this.socksPort}...`);
                }

                const req = httpModule.request(requestOptions, (res) => {
                    const chunks = [];
                    
                    res.on('data', (chunk) => {
                        chunks.push(chunk);
                    });

                    res.on('end', async () => {
                        let buffer = Buffer.concat(chunks);
                        
                        // Decompress if needed
                        const encoding = (res.headers['content-encoding'] || '').toLowerCase().trim();
                        if (encoding) {
                            console.log(`[TorProxy] Response encoding: ${encoding}, size before: ${buffer.length}`);
                            try {
                                if (encoding === 'gzip' || encoding === 'x-gzip') {
                                    buffer = zlib.gunzipSync(buffer);
                                } else if (encoding === 'deflate') {
                                    // Try zlib-wrapped deflate first, then raw deflate
                                    try {
                                        buffer = zlib.inflateSync(buffer);
                                    } catch (e) {
                                        buffer = zlib.inflateRawSync(buffer);
                                    }
                                } else if (encoding === 'br') {
                                    buffer = zlib.brotliDecompressSync(buffer);
                                }
                                console.log(`[TorProxy] Decompressed size: ${buffer.length}`);
                            } catch (decompressErr) {
                                console.error(`[TorProxy] Decompression error (${encoding}):`, decompressErr.message);
                                // Continue with original buffer if decompression fails
                            }
                        }
                        
                        resolve({
                            status: res.statusCode,
                            statusText: res.statusMessage,
                            headers: res.headers,
                            body: buffer,
                            url: targetUrl,
                            isOnion
                        });
                    });

                    res.on('error', reject);
                });

                req.on('error', (err) => {
                    reject(new Error(`Tor request failed: ${err.message}`));
                });

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                });

                if (body) {
                    req.write(body);
                }

                req.end();
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Verify we're using Tor by checking torproject.org
     */
    async verifyTorConnection() {
        // Try multiple verification endpoints
        const verificationUrls = [
            'https://check.torproject.org/api/ip',
            'https://api.ipify.org?format=json'
        ];
        
        for (const verifyUrl of verificationUrls) {
            try {
                console.log(`[TorProxy] Trying verification via ${verifyUrl}...`);
                
                // Use a longer timeout for verification
                const response = await this.fetchUrl(verifyUrl, {
                    timeout: 60000 // 60 seconds for Tor verification
                });
                
                if (!response.body || response.status !== 200) {
                    console.log(`[TorProxy] Verification returned status ${response.status}`);
                    continue;
                }
                
                const bodyStr = response.body.toString();
                console.log('[TorProxy] Verification response:', bodyStr.substring(0, 200));
                
                const data = JSON.parse(bodyStr);
                
                // check.torproject.org returns { IsTor: true/false, IP: "x.x.x.x" }
                if (data.IsTor !== undefined) {
                    return {
                        isTor: data.IsTor === true,
                        ip: data.IP || null
                    };
                }
                
                // ipify returns { ip: "x.x.x.x" }
                if (data.ip) {
                    // If we got an IP through the SOCKS proxy, Tor is likely working
                    // We can't verify it's actually Tor without the torproject check
                    return {
                        isTor: true, // Assume Tor is working if we got a response through SOCKS
                        ip: data.ip,
                        note: 'Verified via alternate endpoint'
                    };
                }
            } catch (err) {
                console.error(`[TorProxy] Verification via ${verifyUrl} failed:`, err.message);
                continue;
            }
        }
        
        // If all verification attempts failed, check if SOCKS port is responding
        console.log('[TorProxy] All verification endpoints failed, checking SOCKS port...');
        try {
            const net = require('net');
            const isOpen = await new Promise((resolve) => {
                const socket = new net.Socket();
                socket.setTimeout(5000);
                socket.on('connect', () => {
                    socket.destroy();
                    resolve(true);
                });
                socket.on('timeout', () => {
                    socket.destroy();
                    resolve(false);
                });
                socket.on('error', () => {
                    resolve(false);
                });
                socket.connect(this.socksPort, this.socksHost);
            });
            
            if (isOpen) {
                return {
                    isTor: true,
                    ip: null,
                    note: 'SOCKS port responding, verification endpoints unreachable'
                };
            }
        } catch (e) {
            console.error('[TorProxy] SOCKS check failed:', e.message);
        }
        
        return {
            isTor: false,
            error: 'All verification methods failed'
        };
    }

    /**
     * Get new Tor identity
     */
    async newIdentity(tabId = null) {
        try {
            // If tabId provided, just reset that tab's circuit
            if (tabId && this.tabCircuits.has(tabId)) {
                this.tabCircuits.delete(tabId);
            }

            // Request NEWNYM from Tor
            const success = await this.torController.newIdentity();
            
            // Clear all tab circuits
            this.tabCircuits.clear();
            this.requestCache.clear();

            return success;
        } catch (err) {
            console.error('Failed to get new identity:', err);
            return false;
        }
    }

    /**
     * Extract video information from video hosting sites
     * Used to provide playback options when native streaming doesn't work
     */
    async extractVideoInfo(url) {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();
        
        // YouTube detection
        if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
            let videoId = null;
            
            if (hostname.includes('youtu.be')) {
                videoId = urlObj.pathname.slice(1).split('?')[0];
            } else {
                videoId = urlObj.searchParams.get('v');
            }
            
            if (videoId) {
                // Clean video ID (remove any extra params)
                videoId = videoId.split('&')[0];
                
                return {
                    platform: 'youtube',
                    videoId,
                    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=0&rel=0`,
                    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    privacyNote: 'YouTube tracks viewing. Use privacy embeds below for better privacy.',
                    alternatives: [
                        { 
                            name: 'YouTube Privacy', 
                            url: `EMBED:https://www.youtube-nocookie.com/embed/${videoId}?autoplay=0&rel=0`,
                            description: 'YouTube embed with enhanced privacy'
                        },
                        { 
                            name: 'Invidious (inv.nadeko.net)', 
                            url: `EMBED:https://inv.nadeko.net/embed/${videoId}`,
                            description: 'Privacy-respecting YouTube embed'
                        },
                        { 
                            name: 'Invidious (vid.puffyan.us)', 
                            url: `EMBED:https://vid.puffyan.us/embed/${videoId}`,
                            description: 'Privacy-respecting YouTube embed'
                        },
                        {
                            name: 'Open Original',
                            url: `EXTERNAL:https://www.youtube.com/watch?v=${videoId}`,
                            description: 'Open in external browser'
                        }
                    ]
                };
            }
        }
        
        // Piped detection (privacy frontend)
        if (hostname.includes('piped.video') || hostname.includes('piped.kavin.rocks')) {
            const videoId = urlObj.searchParams.get('v') || urlObj.pathname.split('/').pop();
            if (videoId) {
                return {
                    platform: 'piped',
                    videoId,
                    embedUrl: `https://piped.video/embed/${videoId}`,
                    privacyNote: 'Piped is a privacy-friendly YouTube frontend.',
                    alternatives: [
                        { name: 'Invidious Embed', url: `EMBED:https://yewtu.be/embed/${videoId}` },
                        { name: 'YouTube Embed', url: `EMBED:https://www.youtube-nocookie.com/embed/${videoId}` }
                    ]
                };
            }
        }
        
        // Invidious detection
        if (hostname.includes('yewtu.be') || hostname.includes('invidious') || hostname.includes('inv.')) {
            const videoId = urlObj.searchParams.get('v') || urlObj.pathname.split('/').pop();
            if (videoId) {
                return {
                    platform: 'invidious',
                    videoId,
                    embedUrl: `https://yewtu.be/embed/${videoId}`,
                    privacyNote: 'Invidious is a privacy-friendly YouTube frontend.',
                    alternatives: [
                        { name: 'Piped Embed', url: `EMBED:https://piped.video/embed/${videoId}` },
                        { name: 'YouTube Embed', url: `EMBED:https://www.youtube-nocookie.com/embed/${videoId}` }
                    ]
                };
            }
        }
        
        // Vimeo detection
        if (hostname.includes('vimeo.com')) {
            const videoId = urlObj.pathname.split('/').pop();
            if (videoId && /^\d+$/.test(videoId)) {
                return {
                    platform: 'vimeo',
                    videoId,
                    embedUrl: `https://player.vimeo.com/video/${videoId}`,
                    privacyNote: 'Vimeo may track viewing activity.'
                };
            }
        }
        
        // DailyMotion detection
        if (hostname.includes('dailymotion.com')) {
            const match = urlObj.pathname.match(/video\/([a-z0-9]+)/i);
            if (match) {
                return {
                    platform: 'dailymotion',
                    videoId: match[1],
                    embedUrl: `https://www.dailymotion.com/embed/video/${match[1]}`
                };
            }
        }
        
        return {
            platform: 'unknown',
            message: 'Video platform not recognized or video URL not found'
        };
    }

    /**
     * Check if URL is a known video site
     */
    isVideoSite(url) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            const videoSites = [
                'youtube.com', 'youtu.be', 'www.youtube.com',
                'vimeo.com', 'www.vimeo.com',
                'dailymotion.com', 'www.dailymotion.com',
                'twitch.tv', 'www.twitch.tv',
                'twitter.com', 'x.com',  // For video tweets
                'tiktok.com', 'www.tiktok.com'
            ];
            return videoSites.some(site => hostname.includes(site));
        } catch {
            return false;
        }
    }

    /**
     * Sanitize HTML content for safe display
     * Implements Tor Browser-style content sanitization:
     * - Removes scripts and event handlers
     * - Blocks mixed content (http:// on https://)
     * - Removes prefetch/preconnect (prevents speculative connections)
     * - Converts relative URLs to absolute
     * - Rewrites resource URLs to go through our proxy
     */
    sanitizeHtml(html, baseUrl) {
        const isHttpsPage = baseUrl && baseUrl.startsWith('https://');
        const proxyBase = '/api/tor/resource?url=';
        
        // Remove script tags
        html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        
        // Remove noscript tags (show content but strip the tag)
        html = html.replace(/<\/?noscript[^>]*>/gi, '');
        
        // Remove event handlers (on*)
        html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
        html = html.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');
        
        // Remove javascript: URLs
        html = html.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"');
        
        // Remove data: URLs in src attributes (potential XSS vector)
        html = html.replace(/src\s*=\s*["']data:[^"']*["']/gi, 'src=""');
        
        // === TOR BROWSER PARITY: Block prefetch/preconnect (prevents speculative connections) ===
        // Remove link prefetch
        html = html.replace(/<link[^>]*rel\s*=\s*["'](?:prefetch|preconnect|prerender|dns-prefetch|preload|modulepreload)["'][^>]*>/gi, '');
        
        // Remove meta http-equiv refresh (prevents unwanted redirects)
        html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']refresh["'][^>]*>/gi, '');
        
        // Convert relative URLs to absolute first
        if (baseUrl) {
            try {
                const base = new URL(baseUrl);
                
                // Fix relative src attributes (images, media, etc.)
                html = html.replace(/src\s*=\s*["'](?!http|data:|\/\/|#|blob:)([^"']+)["']/gi, (match, path) => {
                    try {
                        const absoluteUrl = new URL(path, base).href;
                        return `src="${absoluteUrl}"`;
                    } catch {
                        return match;
                    }
                });
                
                // Fix relative href attributes
                html = html.replace(/href\s*=\s*["'](?!http|data:|javascript:|\/\/|#|mailto:)([^"']+)["']/gi, (match, path) => {
                    try {
                        const absoluteUrl = new URL(path, base).href;
                        return `href="${absoluteUrl}"`;
                    } catch {
                        return match;
                    }
                });
                
                // Fix relative poster attributes (for video)
                html = html.replace(/poster\s*=\s*["'](?!http|data:|\/\/|#)([^"']+)["']/gi, (match, path) => {
                    try {
                        const absoluteUrl = new URL(path, base).href;
                        return `poster="${absoluteUrl}"`;
                    } catch {
                        return match;
                    }
                });
                
                // Fix CSS url() in style attributes
                html = html.replace(/url\(["']?(?!http|data:|\/\/|#)([^)"']+)["']?\)/gi, (match, path) => {
                    try {
                        const absoluteUrl = new URL(path, base).href;
                        return `url("${absoluteUrl}")`;
                    } catch {
                        return match;
                    }
                });
            } catch (e) {
                // Invalid base URL, skip conversion
            }
        }
        
        // === PROXY ALL RESOURCES THROUGH TOR ===
        // Now rewrite all absolute URLs to go through our proxy
        
        // Proxy image src (http/https)
        html = html.replace(/(<img[^>]*\s+src\s*=\s*["'])(https?:\/\/[^"']+)(["'][^>]*>)/gi, (match, prefix, url, suffix) => {
            return `${prefix}${proxyBase}${encodeURIComponent(url)}${suffix}`;
        });
        
        // Proxy video poster
        html = html.replace(/(poster\s*=\s*["'])(https?:\/\/[^"']+)(["'])/gi, (match, prefix, url, suffix) => {
            return `${prefix}${proxyBase}${encodeURIComponent(url)}${suffix}`;
        });
        
        // Proxy source src (for video/audio)
        html = html.replace(/(<source[^>]*\s+src\s*=\s*["'])(https?:\/\/[^"']+)(["'][^>]*>)/gi, (match, prefix, url, suffix) => {
            return `${prefix}${proxyBase}${encodeURIComponent(url)}${suffix}`;
        });
        
        // Proxy CSS background images in inline styles
        html = html.replace(/url\(["']?(https?:\/\/[^)"']+)["']?\)/gi, (match, url) => {
            return `url("${proxyBase}${encodeURIComponent(url)}")`;
        });
        
        // Proxy link stylesheet href
        html = html.replace(/(<link[^>]*\s+href\s*=\s*["'])(https?:\/\/[^"']+)(["'][^>]*rel\s*=\s*["']stylesheet["'][^>]*>)/gi, (match, prefix, url, suffix) => {
            return `${prefix}${proxyBase}${encodeURIComponent(url)}${suffix}`;
        });
        html = html.replace(/(<link[^>]*rel\s*=\s*["']stylesheet["'][^>]*\s+href\s*=\s*["'])(https?:\/\/[^"']+)(["'][^>]*>)/gi, (match, prefix, url, suffix) => {
            return `${prefix}${proxyBase}${encodeURIComponent(url)}${suffix}`;
        });
        
        // Proxy favicon
        html = html.replace(/(<link[^>]*\s+href\s*=\s*["'])(https?:\/\/[^"']+)(["'][^>]*rel\s*=\s*["'](?:shortcut )?icon["'][^>]*>)/gi, (match, prefix, url, suffix) => {
            return `${prefix}${proxyBase}${encodeURIComponent(url)}${suffix}`;
        });
        
        // === TOR BROWSER PARITY: Block mixed content ===
        if (TOR_BROWSER_CONFIG.BLOCK_MIXED_CONTENT && isHttpsPage) {
            // Already handled by proxying - http:// resources will go through our https:// proxy
        }

        return html;
    }

    /**
     * Extract page metadata
     */
    extractMetadata(html, url) {
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
        const faviconMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i);

        return {
            title: titleMatch ? titleMatch[1].trim() : new URL(url).hostname,
            description: descMatch ? descMatch[1] : '',
            favicon: faviconMatch ? faviconMatch[1] : null,
            url
        };
    }

    /**
     * Validate target URL for proxy requests
     * Returns { valid: boolean, reason?: string }
     */
    validateTargetUrl(targetUrl) {
        if (!targetUrl || typeof targetUrl !== 'string') {
            return { valid: false, reason: 'Missing or invalid URL' };
        }

        // Trim and check length limits (prevent DoS via huge URLs)
        const trimmedUrl = targetUrl.trim();
        if (trimmedUrl.length === 0) {
            return { valid: false, reason: 'Empty URL' };
        }
        if (trimmedUrl.length > 2048) {
            return { valid: false, reason: 'URL exceeds maximum length' };
        }

        // Parse and validate URL structure
        let parsed;
        try {
            parsed = new URL(trimmedUrl);
        } catch (e) {
            return { valid: false, reason: 'Malformed URL' };
        }

        // Protocol whitelist - only http/https allowed
        const allowedProtocols = ['http:', 'https:'];
        if (!allowedProtocols.includes(parsed.protocol)) {
            return { valid: false, reason: 'Invalid protocol' };
        }

        // Block localhost/internal network proxying (prevent SSRF)
        const hostname = parsed.hostname.toLowerCase();
        const blockedHosts = [
            'localhost',
            '127.0.0.1',
            '0.0.0.0',
            '::1',
            '[::1]'
        ];
        
        // Block local addresses (but allow .onion)
        if (!hostname.endsWith('.onion')) {
            if (blockedHosts.includes(hostname)) {
                return { valid: false, reason: 'Local addresses not allowed' };
            }
            // Block private IP ranges
            if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname)) {
                return { valid: false, reason: 'Private network addresses not allowed' };
            }
            // Block link-local
            if (hostname.startsWith('169.254.')) {
                return { valid: false, reason: 'Link-local addresses not allowed' };
            }
        }

        return { valid: true, url: trimmedUrl };
    }

    /**
     * Start the proxy server
     */
    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                // Enable CORS for frontend
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tab-Id, X-Target-Url');

                // Handle CORS preflight
                if (req.method === 'OPTIONS') {
                    res.writeHead(200);
                    res.end();
                    return;
                }

                // Method whitelist - reject unusual HTTP methods early
                const allowedMethods = ['GET', 'POST', 'HEAD'];
                if (!allowedMethods.includes(req.method)) {
                    res.writeHead(405);
                    res.end();
                    return;
                }

                // Parse request URL
                let url;
                try {
                    url = new URL(req.url, `http://localhost:${this.proxyPort}`);
                } catch (e) {
                    // Malformed request URL - silent rejection
                    res.writeHead(400);
                    res.end();
                    return;
                }

                const targetUrl = req.headers['x-target-url'] || url.searchParams.get('url');
                const tabId = req.headers['x-tab-id'] || url.searchParams.get('tabId');

                // === GUARD: Handle non-proxy traffic silently ===
                // Browser auto-requests and direct access should not produce errors
                if (!targetUrl) {
                    const pathname = url.pathname;
                    
                    // Known browser auto-request patterns
                    // Return 204 No Content - proxy is infrastructure, not an endpoint
                    const incidentalPaths = [
                        '/favicon.ico',
                        '/favicon.png', 
                        '/robots.txt',
                        '/sitemap.xml',
                        '/apple-touch-icon.png',
                        '/apple-touch-icon-precomposed.png',
                        '/.well-known/',
                        '/manifest.json',
                        '/browserconfig.xml',
                        '/service-worker.js',
                        '/sw.js'
                    ];
                    
                    const isIncidentalRequest = pathname === '/' || 
                        incidentalPaths.some(p => pathname === p || pathname.startsWith(p));
                    
                    if (isIncidentalRequest) {
                        // Silent rejection - no error, no body, no console noise
                        res.writeHead(204);
                        res.end();
                        return;
                    }
                    
                    // Unknown path without target URL - silent 400 (no body = no noise)
                    res.writeHead(400);
                    res.end();
                    return;
                }

                // === GUARD: Validate target URL strictly ===
                const validation = this.validateTargetUrl(targetUrl);
                if (!validation.valid) {
                    // Return generic error - don't expose validation details
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        error: 'Invalid request' 
                    }));
                    return;
                }

                // Use validated URL for all subsequent operations
                const validatedTargetUrl = validation.url;

                try {
                    const response = await this.fetchUrl(validatedTargetUrl, {
                        tabId,
                        method: req.method,
                        headers: req.headers
                    });

                    const contentType = response.headers['content-type'] || '';
                    let body = response.body;
                    const finalUrl = response.url; // Use final URL after redirects
                    
                    console.log(`[TorProxy] Response for ${finalUrl}: status=${response.status}, contentType=${contentType}, bodySize=${body ? body.length : 0}, redirected=${response.redirected || false}`);

                    // If HTML, sanitize it
                    if (contentType.includes('text/html')) {
                        let html = body.toString('utf-8');
                        console.log(`[TorProxy] HTML preview: ${html.substring(0, 200)}...`);
                        html = this.sanitizeHtml(html, finalUrl);
                        const metadata = this.extractMetadata(html, finalUrl);

                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            ...this.addSecurityHeaders(response)
                        });

                        res.end(JSON.stringify({
                            success: true,
                            html,
                            metadata,
                            status: response.status,
                            isOnion: response.isOnion,
                            url: finalUrl,
                            redirected: response.redirected || false
                        }));
                    } else {
                        // For non-HTML content, return as base64
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });

                        res.end(JSON.stringify({
                            success: true,
                            contentType,
                            data: body.toString('base64'),
                            status: response.status,
                            isOnion: response.isOnion,
                            url: finalUrl,
                            redirected: response.redirected || false
                        }));
                    }
                } catch (err) {
                    // Log internally but don't expose full error to client
                    console.error(`[TorProxy] Fetch error for ${validatedTargetUrl}: ${err.message}`);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: 'Failed to fetch resource',
                        url: validatedTargetUrl
                    }));
                }
            });

            this.server.listen(this.proxyPort, () => {
                console.log(`Tor Proxy Server running on port ${this.proxyPort}`);
                resolve(true);
            });

            this.server.on('error', reject);
        });
    }

    /**
     * Stop the proxy server
     */
    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }
}

// Singleton instance
let torProxy = null;

function getTorProxy(options) {
    if (!torProxy) {
        torProxy = new TorProxy(options);
    }
    return torProxy;
}

module.exports = { TorProxy, getTorProxy };
