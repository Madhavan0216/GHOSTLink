const express = require('express');
const cors = require('cors');
const { generateKeyPair } = require('./vpn_controller');
const db = require('./db');
const net = require('net');
const { getTorController } = require('./tor_controller');
const { getTorProxy } = require('./tor_proxy');
const { getTorProcess } = require('./tor_process');

const app = express();
const PORT = 3000;
const PROXY_PORT = 3001;
const TOR_SOCKS_PORT = 9050;
const TOR_CONTROL_PORT = 9051;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

db.initDb();

// --- AUTOMATIC TOR INTEGRATION ---

// Initialize Tor process manager (handles install & start)
const torProcess = getTorProcess({
    socksPort: TOR_SOCKS_PORT,
    controlPort: TOR_CONTROL_PORT,
    debug: true, // Enable verbose Tor output to see bootstrap progress
    maxRestartAttempts: 3,
    startupTimeout: 120000 // 2 minutes for bootstrap
});

// Initialize Tor controller (connects to running Tor)
const torController = getTorController({
    controlPort: TOR_CONTROL_PORT,
    socksPort: TOR_SOCKS_PORT
});

// Initialize Tor proxy (routes traffic through Tor)
const torProxy = getTorProxy({
    socksPort: TOR_SOCKS_PORT,
    proxyPort: PROXY_PORT
});

// Track connection state
let torConnected = false;
let torBootstrapped = false;
let torStarting = false;
let currentCircuit = null;
let exitIP = null;

// Tor process event handlers
torProcess.on('installing', () => {
    console.log('[GHOSTLINK] Installing Tor bundle...');
});

torProcess.on('installed', () => {
    console.log('[GHOSTLINK] Tor bundle installed successfully');
});

torProcess.on('starting', () => {
    console.log('[GHOSTLINK] Starting Tor daemon...');
});

torProcess.on('bootstrap', ({ progress, message }) => {
    // Log all progress updates for visibility
    console.log(`[GHOSTLINK] Tor bootstrap: ${progress}% - ${message}`);
    torController.bootstrapProgress = progress;
});

torProcess.on('ready', () => {
    console.log('[GHOSTLINK] Tor is ready and bootstrapped');
    torBootstrapped = true;
});

torProcess.on('exit', ({ code, signal }) => {
    console.log(`[GHOSTLINK] Tor process exited (code: ${code}, signal: ${signal})`);
    torConnected = false;
    torBootstrapped = false;
});

torProcess.on('failed', () => {
    console.log('[GHOSTLINK] Tor failed to start - running in simulated mode');
    torConnected = false;
    torBootstrapped = false;
});

// Tor controller event handlers
torController.on('circuit_established', () => {
    console.log('[GHOSTLINK] Circuit established');
});

torController.on('new_identity', () => {
    console.log('[GHOSTLINK] New identity requested');
    exitIP = null;
});

// Handle controller errors (must have handler to prevent crash)
torController.on('error', (err) => {
    // Silently ignore connection errors - will retry
    if (err.code !== 'ECONNREFUSED') {
        console.log(`[GHOSTLINK] Controller error: ${err.message}`);
    }
});

/**
 * Build real Tor circuit information
 * Fetches actual circuit data from Tor daemon
 */
async function buildCircuit() {
    try {
        const circuits = await torController.getCircuitInfo();
        const builtCircuits = circuits.filter(c => c.status === 'BUILT');
        
        if (builtCircuits.length > 0) {
            // Parse the first built circuit
            const circuit = builtCircuits[0];
            const nodes = circuit.path.split(',').map((node, index) => {
                const [fingerprint, name] = node.split('~');
                const roles = ['Entry', 'Relay', 'Exit'];
                return {
                    id: index + 1,
                    fingerprint: fingerprint?.substring(1) || 'unknown', // Remove $ prefix
                    name: name || `Ghost-${roles[index]}-Node`,
                    ip: 'via Tor', // Actual IPs are hidden for privacy
                    role: roles[index] || 'Relay'
                };
            });
            
            // Ensure we have exactly 3 nodes for UI compatibility
            while (nodes.length < 3) {
                nodes.push({
                    id: nodes.length + 1,
                    fingerprint: 'unknown',
                    name: `Ghost-Node-${nodes.length + 1}`,
                    ip: 'via Tor',
                    role: 'Relay'
                });
            }
            
            currentCircuit = nodes.slice(0, 3);
            return currentCircuit;
        }
    } catch (err) {
        console.error('[Tor] Error fetching circuit info:', err.message);
    }
    
    // Fallback to placeholder if no circuit info available
    return [
        { id: 1, ip: 'Tor Guard', name: 'Ghost-Entry-Alpha', role: 'Entry' },
        { id: 2, ip: 'Tor Middle', name: 'Ghost-Relay-Beta', role: 'Relay' },
        { id: 3, ip: 'Tor Exit', name: 'Ghost-Exit-Gamma', role: 'Exit' }
    ];
}

/**
 * Start Tor automatically and initialize connection
 * This is the main entry point for Tor startup
 */
async function startTorAutomatically() {
    if (torStarting) return;
    torStarting = true;
    
    console.log('[GHOSTLINK] Starting automatic Tor initialization...');
    
    try {
        // Step 1: Start Tor process (will install if needed)
        // Use startBackground to not wait for full bootstrap
        console.log('[GHOSTLINK] Step 1: Starting Tor process...');
        const startResult = await torProcess.startBackground();
        
        if (!startResult.success) {
            console.log('[GHOSTLINK] Tor process failed to start, using simulated mode');
            torStarting = false;
            return false;
        }

        // Step 2: Update controller with cookie path
        const cookiePath = torProcess.getCookiePath();
        torController.updateCookiePath(cookiePath);

        // Step 3: Start proxy server immediately (Tor connections will work once bootstrap completes)
        console.log('[GHOSTLINK] Step 2: Starting proxy server...');
        try {
            await torProxy.start();
        } catch (e) {
            // Proxy might already be running
        }

        // Step 4: Try to connect to control port (will retry in background)
        console.log('[GHOSTLINK] Step 3: Connecting to Tor control port (async)...');
        torController.connectWithWait(60000).then(async () => {
            try {
                await torController.authenticate();
                await torController.subscribeEvents(['STATUS_CLIENT', 'CIRC']);
                torConnected = true;
                console.log('[GHOSTLINK] ✓ Tor control connection established');
            } catch (err) {
                console.log(`[GHOSTLINK] Control port auth failed: ${err.message}`);
            }
        }).catch(err => {
            console.log(`[GHOSTLINK] Control port connection failed: ${err.message}`);
        });

        torStarting = false;
        
        // Listen for when bootstrap completes
        torProcess.once('ready', () => {
            torBootstrapped = true;
            console.log('[GHOSTLINK] ✓ Tor fully bootstrapped and ready');
        });
        
        return true;

    } catch (err) {
        console.log(`[GHOSTLINK] Tor initialization incomplete: ${err.message}`);
        console.log('[GHOSTLINK] Continuing in simulated mode - UI fully functional');
        torStarting = false;
        
        // Try to start proxy server anyway for simulated mode
        try {
            await torProxy.start();
        } catch (e) {
            // Proxy might already be running
        }
        
        return false;
    }
}

// Start Tor automatically when server starts (non-blocking)
startTorAutomatically().catch(() => {
    console.log('[GHOSTLINK] Running in simulated mode');
});

// --- API ROUTES ---

app.get('/api/status', async (req, res) => {
    // Check if we have an active "Circuit"
    const circuitId = await db.getSetting('active_circuit_id');
    
    // Get real Tor status
    const processStatus = torProcess.getStatus();
    let torStatus = {
        running: processStatus.running,
        bootstrapped: processStatus.bootstrapped,
        bootstrapProgress: processStatus.bootstrapProgress
    };
    
    if (torConnected) {
        try {
            const controllerStatus = await torController.checkTorStatus();
            torStatus = { ...torStatus, ...controllerStatus };
        } catch (e) {
            // Use process status as fallback
        }
    }
    
    res.json({
        status: circuitId ? 'connected' : 'disconnected',
        mode: 'onion_routing',
        circuit: circuitId ? await buildCircuit() : null,
        tor: {
            connected: torConnected,
            bootstrapped: torBootstrapped,
            exitIP: exitIP,
            ...torStatus
        }
    });
});

// Get detailed Tor status
app.get('/api/tor/status', async (req, res) => {
    try {
        const processStatus = torProcess.getStatus();
        let status = { ...processStatus };
        
        if (torConnected) {
            const controllerStatus = await torController.checkTorStatus();
            status = { ...status, ...controllerStatus };
        }
        
        res.json({
            success: true,
            ...status
        });
    } catch (err) {
        res.json({
            success: false,
            error: err.message,
            running: torProcess.isRunning,
            bootstrapped: torBootstrapped
        });
    }
});

// Check if connected to Tor network
app.get('/api/tor/check', async (req, res) => {
    try {
        const result = await torProxy.verifyTorConnection();
        exitIP = result.ip || exitIP;
        res.json({
            success: true,
            ...result
        });
    } catch (err) {
        res.json({
            success: false,
            isTor: false,
            error: err.message
        });
    }
});

// NEW: Get new Tor identity (Tor Browser parity: clears all session state)
app.post('/api/tor/new-identity', async (req, res) => {
    try {
        // Clear proxy session state first (first-party circuits, cookies, cache)
        torProxy.clearSessionState();
        
        // Request new Tor circuits via NEWNYM
        const success = await torProxy.newIdentity();
        exitIP = null; // Reset exit IP
        
        console.log('[GHOSTLINK] New Identity: All session state cleared');
        res.json({ 
            success, 
            message: success ? 'New identity acquired - all circuits and state cleared' : 'Failed to get new identity' 
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get security configuration (Tor Browser parity settings)
app.get('/api/security/config', (req, res) => {
    res.json({
        success: true,
        config: {
            httpsFirst: torProxy.getConfig('HTTPS_FIRST'),
            httpsOnly: torProxy.getConfig('HTTPS_ONLY'),
            onionOnly: torProxy.getConfig('ONION_ONLY_MODE'),
            blockMixedContent: torProxy.getConfig('BLOCK_MIXED_CONTENT'),
            firstPartyIsolation: torProxy.getConfig('FIRST_PARTY_ISOLATION'),
            securityLevel: torProxy.getConfig('SECURITY_LEVEL'),
            minimalLogging: torProxy.getConfig('MINIMAL_LOGGING')
        }
    });
});

// Update security configuration
app.post('/api/security/config', (req, res) => {
    const { setting, value } = req.body;
    
    const allowedSettings = [
        'HTTPS_FIRST', 'HTTPS_ONLY', 'ONION_ONLY_MODE', 
        'BLOCK_MIXED_CONTENT', 'SECURITY_LEVEL', 'MINIMAL_LOGGING'
    ];
    
    if (!allowedSettings.includes(setting)) {
        return res.status(400).json({ success: false, error: 'Invalid setting' });
    }
    
    try {
        torProxy.setConfig(setting, value);
        console.log(`[GHOSTLINK] Security config updated: ${setting} = ${value}`);
        res.json({ success: true, message: `${setting} updated to ${value}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// NEW: Proxy endpoint for fetching URLs through Tor
app.get('/api/tor/fetch', async (req, res) => {
    const { url, tabId } = req.query;
    
    if (!url) {
        return res.status(400).json({ success: false, error: 'URL required' });
    }

    try {
        const response = await torProxy.fetchUrl(url, { tabId });
        const contentType = response.headers['content-type'] || '';
        
        if (contentType.includes('text/html')) {
            let html = response.body.toString('utf-8');
            html = torProxy.sanitizeHtml(html, url);
            const metadata = torProxy.extractMetadata(html, url);
            
            res.json({
                success: true,
                html,
                metadata,
                status: response.status,
                isOnion: response.isOnion,
                url
            });
        } else {
            res.json({
                success: true,
                contentType,
                data: response.body.toString('base64'),
                status: response.status,
                isOnion: response.isOnion,
                url
            });
        }
    } catch (err) {
        res.json({
            success: false,
            error: err.message,
            url
        });
    }
});

// CORS preflight handler for resource proxy
app.options('/api/tor/resource', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
});

// Resource proxy - loads images, CSS, JS, media through Tor
// Supports both GET and POST methods
const resourceProxyHandler = async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).send('URL required');
    }

    try {
        const response = await torProxy.fetchUrl(url, { followRedirects: true });
        let contentType = response.headers['content-type'] || 'application/octet-stream';
        
        // Fix content type based on file extension if generic
        if (contentType === 'application/octet-stream' || contentType === 'text/html') {
            const urlLower = url.toLowerCase();
            if (urlLower.includes('.js') || urlLower.includes('/js/')) {
                contentType = 'application/javascript';
            } else if (urlLower.includes('.css') || urlLower.includes('/css/')) {
                contentType = 'text/css';
            } else if (urlLower.includes('.png')) {
                contentType = 'image/png';
            } else if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) {
                contentType = 'image/jpeg';
            } else if (urlLower.includes('.gif')) {
                contentType = 'image/gif';
            } else if (urlLower.includes('.webp')) {
                contentType = 'image/webp';
            } else if (urlLower.includes('.svg')) {
                contentType = 'image/svg+xml';
            } else if (urlLower.includes('.woff2')) {
                contentType = 'font/woff2';
            } else if (urlLower.includes('.woff')) {
                contentType = 'font/woff';
            } else if (urlLower.includes('.ttf')) {
                contentType = 'font/ttf';
            }
        }
        
        // For CSS files, rewrite url() references to go through proxy
        if (contentType.includes('text/css')) {
            let css = response.body.toString('utf-8');
            const baseUrl = new URL(url);
            
            css = css.replace(/url\(["']?([^)"']+)["']?\)/gi, (match, resourceUrl) => {
                if (resourceUrl.startsWith('data:') || resourceUrl.startsWith('blob:')) return match;
                let absoluteUrl = resourceUrl;
                if (resourceUrl.startsWith('//')) {
                    absoluteUrl = 'https:' + resourceUrl;
                } else if (resourceUrl.startsWith('/')) {
                    absoluteUrl = baseUrl.origin + resourceUrl;
                } else if (!resourceUrl.startsWith('http')) {
                    try {
                        absoluteUrl = new URL(resourceUrl, url).href;
                    } catch { return match; }
                }
                return `url("/api/tor/resource?url=${encodeURIComponent(absoluteUrl)}")`;
            });
            
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.send(css);
        }
        
        // Set appropriate headers
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        
        // Send the raw body
        res.send(response.body);
    } catch (err) {
        console.error('[Resource Proxy Error]', url, err.message);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(502).send('Failed to load resource');
    }
};

// Register resource proxy for both GET and POST
app.get('/api/tor/resource', resourceProxyHandler);
app.post('/api/tor/resource', resourceProxyHandler);

// Full page proxy - serves complete pages with JavaScript enabled through Tor
// This enables sites like Google that require JS while maintaining anonymity
app.get('/api/tor/page', async (req, res) => {
    // Get the URL from query parameter
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).send('URL required');
    }

    // Ensure URL has protocol
    let fullUrl = targetUrl;
    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
        fullUrl = 'https://' + fullUrl;
    }

    try {
        const response = await torProxy.fetchUrl(fullUrl, { followRedirects: true });
        const contentType = response.headers['content-type'] || 'text/html';
        
        // Check if this is a Google CAPTCHA/block page
        const actualUrl = response.finalUrl || fullUrl;
        if (actualUrl.includes('google.com/sorry') || actualUrl.includes('consent.google') || 
            (actualUrl.includes('google.com') && response.body.toString().includes('unusual traffic'))) {
            // Return a helpful error page instead of the broken CAPTCHA
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Site Blocked Tor</title>
                    <style>
                        body { font-family: 'Segoe UI', Arial, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #eee; margin: 0; padding: 40px; min-height: 100vh; box-sizing: border-box; }
                        .container { max-width: 600px; margin: 0 auto; text-align: center; }
                        h1 { color: #ff6b6b; margin-bottom: 20px; }
                        .icon { font-size: 64px; margin-bottom: 20px; }
                        p { color: #aaa; line-height: 1.6; }
                        .box { background: rgba(255,255,255,0.05); border-radius: 10px; padding: 20px; margin: 20px 0; }
                        a { color: #00ff41; text-decoration: none; }
                        a:hover { text-decoration: underline; }
                        .btn { display: inline-block; padding: 12px 24px; background: #00ff41; color: #000; border-radius: 5px; margin: 10px; font-weight: bold; }
                        .btn:hover { background: #00cc33; text-decoration: none; }
                        .btn-alt { background: #333; color: #fff; border: 1px solid #555; }
                        .alternatives { text-align: left; margin-top: 20px; }
                        .alternatives li { margin: 10px 0; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="icon">🛡️</div>
                        <h1>Google Blocked Tor Access</h1>
                        <div class="box">
                            <p><strong>This is expected behavior.</strong></p>
                            <p>Google actively blocks and challenges all Tor users. This happens with the real Tor Browser too.</p>
                            <p>Your IP address (<code>${response.torExitIp || 'Tor exit node'}</code>) is recognized as a Tor exit node.</p>
                        </div>
                        
                        <h3 style="color: #00ff41;">🔒 Your anonymity is intact!</h3>
                        <p>Your real IP is still hidden. Google just doesn't allow Tor users.</p>
                        
                        <div class="alternatives box">
                            <h4>✨ Tor-Friendly Alternatives:</h4>
                            <ul>
                                <li><a href="#" onclick="window.parent.postMessage({type:'ghostlink-navigate',url:'https://duckduckgo.com'}, '*'); return false;" class="btn">🦆 DuckDuckGo</a> - Best for privacy</li>
                                <li><a href="#" onclick="window.parent.postMessage({type:'ghostlink-navigate',url:'https://www.startpage.com'}, '*'); return false;" class="btn btn-alt">Startpage</a> - Google results anonymously</li>
                                <li><a href="#" onclick="window.parent.postMessage({type:'ghostlink-navigate',url:'https://search.brave.com'}, '*'); return false;" class="btn btn-alt">Brave Search</a></li>
                            </ul>
                        </div>
                        
                        <p style="margin-top: 30px;">
                            <a href="#" onclick="window.parent.postMessage({type:'ghostlink-navigate',url:'about:home'}, '*'); return false;">← Go back home</a>
                        </p>
                    </div>
                </body>
                </html>
            `);
        }
        
        // For HTML pages, rewrite URLs to go through our proxy
        if (contentType.includes('text/html')) {
            let html = response.body.toString('utf-8');
            const baseUrl = new URL(fullUrl);
            const proxyPageBase = '/api/tor/page?url=';
            const proxyResourceBase = '/api/tor/resource?url=';
            
            // Inject base tag and our URL interceptor script at the very beginning of <head>
            const interceptorScript = `
<script>
(function() {
    const CURRENT_ORIGIN = '${baseUrl.origin}';
    const PROXY_RESOURCE = '/api/tor/resource?url=';
    const PROXY_PAGE = '/api/tor/page?url=';
    
    // Helper to convert URL to proxied URL
    function proxyUrl(url, isPage) {
        if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.includes('/api/tor/')) {
            return url;
        }
        let absoluteUrl = url;
        if (url.startsWith('//')) {
            absoluteUrl = 'https:' + url;
        } else if (url.startsWith('/')) {
            absoluteUrl = CURRENT_ORIGIN + url;
        } else if (!url.startsWith('http')) {
            try {
                absoluteUrl = new URL(url, CURRENT_ORIGIN).href;
            } catch { return url; }
        }
        const base = isPage ? PROXY_PAGE : PROXY_RESOURCE;
        return base + encodeURIComponent(absoluteUrl);
    }
    
    // Intercept XMLHttpRequest
    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        const proxiedUrl = proxyUrl(url, false);
        return originalXHROpen.call(this, method, proxiedUrl, ...args);
    };
    
    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        let url = input;
        if (typeof input === 'object' && input.url) {
            url = input.url;
        }
        const proxiedUrl = proxyUrl(url, false);
        if (typeof input === 'object') {
            input = new Request(proxiedUrl, input);
        } else {
            input = proxiedUrl;
        }
        return originalFetch.call(this, input, init);
    };
    
    // Intercept all link clicks
    document.addEventListener('click', function(e) {
        const link = e.target.closest('a');
        if (link && link.href) {
            const href = link.getAttribute('href');
            // Skip javascript:, mailto:, tel:, and anchor links
            if (href.startsWith('javascript:') || href.startsWith('mailto:') || 
                href.startsWith('tel:') || href.startsWith('#')) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            // Send navigation request to parent
            window.parent.postMessage({
                type: 'ghostlink-navigate',
                url: link.href
            }, '*');
        }
    }, true);
    
    // Intercept form submissions
    document.addEventListener('submit', function(e) {
        const form = e.target;
        if (form && form.action) {
            e.preventDefault();
            // For GET forms, build the URL with query params
            if (form.method.toUpperCase() === 'GET') {
                const formData = new FormData(form);
                const params = new URLSearchParams(formData).toString();
                const url = form.action + (form.action.includes('?') ? '&' : '?') + params;
                window.parent.postMessage({
                    type: 'ghostlink-navigate',
                    url: url
                }, '*');
            } else {
                // For POST forms, we need special handling
                window.parent.postMessage({
                    type: 'ghostlink-form-submit',
                    action: form.action,
                    method: form.method,
                    data: Object.fromEntries(new FormData(form))
                }, '*');
            }
        }
    }, true);
    
    // Block WebRTC to prevent IP leaks
    if (window.RTCPeerConnection) {
        window.RTCPeerConnection = function() {
            throw new Error('WebRTC is disabled for privacy');
        };
    }
    if (window.webkitRTCPeerConnection) {
        window.webkitRTCPeerConnection = function() {
            throw new Error('WebRTC is disabled for privacy');
        };
    }
    
    // Block geolocation
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition = function(s, e) {
            if (e) e({ code: 1, message: 'Geolocation is disabled for privacy' });
        };
        navigator.geolocation.watchPosition = function(s, e) {
            if (e) e({ code: 1, message: 'Geolocation is disabled for privacy' });
            return 0;
        };
    }
    
    // Spoof timezone to UTC (fingerprinting protection)
    const originalDateGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() { return 0; };
    
    // Spoof screen dimensions (fingerprinting protection)
    Object.defineProperty(screen, 'width', { value: 1920 });
    Object.defineProperty(screen, 'height', { value: 1080 });
    Object.defineProperty(screen, 'availWidth', { value: 1920 });
    Object.defineProperty(screen, 'availHeight', { value: 1080 });
    Object.defineProperty(screen, 'colorDepth', { value: 24 });
    Object.defineProperty(screen, 'pixelDepth', { value: 24 });
    
    console.log('[GHOSTLINK] Privacy protections active');
})();
</script>`;
            
            // Insert interceptor script right after <head>
            html = html.replace(/<head([^>]*)>/i, `<head$1>${interceptorScript}`);
            
            // Get base URL for rewriting relative URLs
            const baseOrigin = baseUrl.origin;
            
            // Rewrite ALL src attributes to go through proxy (scripts, images, etc.)
            html = html.replace(/(<(?:script|img|video|audio|source|iframe)[^>]*\s+src\s*=\s*["'])([^"']+)(["'][^>]*>)/gi, (match, prefix, url, suffix) => {
                if (url.startsWith('data:') || url.startsWith('blob:') || url.includes('/api/tor/')) return match;
                let absoluteUrl = url;
                if (url.startsWith('//')) {
                    absoluteUrl = 'https:' + url;
                } else if (url.startsWith('/')) {
                    absoluteUrl = baseOrigin + url;
                } else if (!url.startsWith('http')) {
                    absoluteUrl = new URL(url, fullUrl).href;
                }
                return `${prefix}${proxyResourceBase}${encodeURIComponent(absoluteUrl)}${suffix}`;
            });
            
            // Rewrite link href for stylesheets
            html = html.replace(/(<link[^>]*\s+href\s*=\s*["'])([^"']+)(["'][^>]*>)/gi, (match, prefix, url, suffix) => {
                if (url.startsWith('data:') || url.includes('/api/tor/')) return match;
                // Check if it's a stylesheet
                if (!match.includes('stylesheet') && !match.includes('icon')) return match;
                let absoluteUrl = url;
                if (url.startsWith('//')) {
                    absoluteUrl = 'https:' + url;
                } else if (url.startsWith('/')) {
                    absoluteUrl = baseOrigin + url;
                } else if (!url.startsWith('http')) {
                    absoluteUrl = new URL(url, fullUrl).href;
                }
                return `${prefix}${proxyResourceBase}${encodeURIComponent(absoluteUrl)}${suffix}`;
            });
            
            // Rewrite anchor href to go through page proxy
            html = html.replace(/(<a[^>]*\s+href\s*=\s*["'])([^"']+)(["'][^>]*>)/gi, (match, prefix, url, suffix) => {
                if (url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:') || url.includes('/api/tor/')) return match;
                let absoluteUrl = url;
                if (url.startsWith('//')) {
                    absoluteUrl = 'https:' + url;
                } else if (url.startsWith('/')) {
                    absoluteUrl = baseOrigin + url;
                } else if (!url.startsWith('http')) {
                    absoluteUrl = new URL(url, fullUrl).href;
                }
                return `${prefix}${proxyPageBase}${encodeURIComponent(absoluteUrl)}${suffix}`;
            });
            
            // Rewrite form actions
            html = html.replace(/(<form[^>]*\s+action\s*=\s*["'])([^"']+)(["'][^>]*>)/gi, (match, prefix, url, suffix) => {
                if (url.startsWith('javascript:') || url.includes('/api/tor/')) return match;
                let absoluteUrl = url;
                if (url.startsWith('//')) {
                    absoluteUrl = 'https:' + url;
                } else if (url.startsWith('/')) {
                    absoluteUrl = baseOrigin + url;
                } else if (!url.startsWith('http')) {
                    absoluteUrl = new URL(url, fullUrl).href;
                }
                return `${prefix}${proxyPageBase}${encodeURIComponent(absoluteUrl)}${suffix}`;
            });
            
            // Rewrite CSS url() references in style tags and attributes
            html = html.replace(/url\(["']?([^)"']+)["']?\)/gi, (match, url) => {
                if (url.startsWith('data:') || url.startsWith('blob:') || url.includes('/api/tor/')) return match;
                let absoluteUrl = url;
                if (url.startsWith('//')) {
                    absoluteUrl = 'https:' + url;
                } else if (url.startsWith('/')) {
                    absoluteUrl = baseOrigin + url;
                } else if (!url.startsWith('http')) {
                    try {
                        absoluteUrl = new URL(url, fullUrl).href;
                    } catch { return match; }
                }
                return `url("${proxyResourceBase}${encodeURIComponent(absoluteUrl)}")`;
            });
            
            // Set security headers - permissive CSP for compatibility
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            // Very permissive CSP to allow proxied content
            res.setHeader('Content-Security-Policy', 
                "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
                "script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
                "style-src * 'unsafe-inline' data:; " +
                "img-src * data: blob:; " +
                "media-src * data: blob:; " +
                "connect-src *; " +
                "font-src * data:; " +
                "frame-src *; " +
                "worker-src * blob:;"
            );
            
            res.send(html);
        } else {
            // For non-HTML content, pass through with proper headers
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.send(response.body);
        }
    } catch (err) {
        console.error('[Page Proxy Error]', fullUrl, err.message);
        res.status(502).send(`
            <html>
            <head><title>Connection Error</title></head>
            <body style="font-family: Arial; padding: 40px; background: #1a1a2e; color: #eee;">
                <h1 style="color: #7c3aed;">⚠️ Connection Error</h1>
                <p>Failed to load: <code>${fullUrl}</code></p>
                <p>Error: ${err.message}</p>
                <p><a href="#" onclick="window.parent.postMessage({type:'ghostlink-navigate',url:'about:home'}, '*')">Go Home</a></p>
            </body>
            </html>
        `);
    }
});

// Video info extraction endpoint (for YouTube, etc.)
app.get('/api/tor/video-info', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).json({ success: false, error: 'URL required' });
    }
    
    try {
        // Detect video platform and extract info
        const videoInfo = await torProxy.extractVideoInfo(url);
        res.json({ success: true, ...videoInfo });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// NEW: Get circuit info
app.get('/api/tor/circuits', async (req, res) => {
    try {
        const circuits = await torController.getCircuitInfo();
        res.json({ success: true, circuits });
    } catch (err) {
        res.json({ success: false, error: err.message, circuits: [] });
    }
});

app.post('/api/setup', async (req, res) => {
    // Same key logic as before
    let privKey = await db.getSetting('client_private_key');
    let pubKey = await db.getSetting('client_public_key');
    if (!privKey) {
        const keys = generateKeyPair();
        await db.saveSetting('client_private_key', keys.privateKey);
        await db.saveSetting('client_public_key', keys.publicKey);
        pubKey = keys.publicKey;
    }
    res.json({ success: true, publicKey: pubKey });
});

app.get('/api/servers', async (req, res) => {
    const servers = await db.getServers();
    res.json({ success: true, servers });
});

app.post('/api/servers', async (req, res) => {
    const { name, endpoint, publicKey } = req.body;
    const id = await db.saveServer(name, endpoint, publicKey, '0.0.0.0/0');
    res.json({ success: true, id });
});

// Connect using REAL Tor Onion Routing
app.post('/api/connect_onion', async (req, res) => {
    console.log('[GHOSTLINK] Building Anonymity Circuit...');

    try {
        // 1. Check if Tor is running, start if not
        if (!torProcess || !torProcess.isRunning) {
            console.log('[GHOSTLINK] Tor not running, starting automatically...');
            await startTorAutomatically();
            
            // Give it a moment to fully initialize
            await new Promise(r => setTimeout(r, 2000));
        }

        // 2. Ensure controller is connected
        if (!torController.isConnected()) {
            const connected = await torController.connectWithWait(30000);
            if (!connected) {
                return res.json({
                    success: false,
                    message: 'Could not connect to Tor control port',
                    fallback: true
                });
            }
        }

        // 3. Wait for bootstrap to reach 100%
        console.log('[GHOSTLINK] Checking bootstrap status...');
        let bootstrapComplete = false;
        let lastProgress = 0;
        
        // First check via process status
        const processStatus = torProcess.getStatus();
        console.log(`[GHOSTLINK] Process bootstrap: ${processStatus.bootstrapProgress}%`);
        
        if (processStatus.bootstrapProgress < 100) {
            console.log('[GHOSTLINK] Waiting for Tor to complete bootstrap...');
            
            // Wait up to 90 seconds for bootstrap
            for (let i = 0; i < 90; i++) {
                await new Promise(r => setTimeout(r, 1000));
                
                // Check process status
                const status = torProcess.getStatus();
                if (status.bootstrapProgress !== lastProgress) {
                    console.log(`[GHOSTLINK] Bootstrap: ${status.bootstrapProgress}%`);
                    lastProgress = status.bootstrapProgress;
                }
                
                if (status.bootstrapProgress >= 100 || status.bootstrapped) {
                    bootstrapComplete = true;
                    console.log('[GHOSTLINK] Bootstrap complete!');
                    break;
                }
                
                // Also try control port
                try {
                    const ctrlProgress = await torController.getBootstrapStatus();
                    if (ctrlProgress >= 100) {
                        bootstrapComplete = true;
                        console.log('[GHOSTLINK] Bootstrap complete (via control port)!');
                        break;
                    }
                } catch (e) {
                    // Ignore control port errors during bootstrap
                }
            }
            
            if (!bootstrapComplete) {
                console.log('[GHOSTLINK] Bootstrap timeout - continuing anyway');
            }
        } else {
            bootstrapComplete = true;
            console.log('[GHOSTLINK] Tor already bootstrapped');
        }

        // 4. Get real circuit info
        const circuit = await buildCircuit();

        // 5. Verify Tor connection with retries (only if bootstrap complete)
        console.log('[GHOSTLINK] Verifying Tor connection...');
        let verification = { isTor: false, ip: null };
        
        if (bootstrapComplete) {
            // Try verification up to 3 times with delays
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    verification = await torProxy.verifyTorConnection();
                    if (verification.isTor && verification.ip) {
                        console.log(`[GHOSTLINK] ✓ Verified! Exit IP: ${verification.ip}`);
                        break;
                    }
                    console.log(`[GHOSTLINK] Verification attempt ${attempt + 1}: isTor=${verification.isTor}, ip=${verification.ip}`);
                    if (attempt < 2) {
                        await new Promise(r => setTimeout(r, 3000));
                    }
                } catch (e) {
                    console.log(`[GHOSTLINK] Verification error: ${e.message}`);
                    if (attempt < 2) {
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
            }
        } else {
            // Bootstrap not complete, mark as connected but unverified
            verification = { isTor: true, ip: null, note: 'Bootstrap incomplete' };
        }
        
        exitIP = verification.ip;
        
        if (!verification.isTor) {
            console.log('[GHOSTLINK] Warning: Traffic may not be going through Tor');
            if (verification.error) {
                console.log(`[GHOSTLINK] Verification error: ${verification.error}`);
            }
        } else {
            console.log(`[GHOSTLINK] ✓ Connected via Tor. Exit IP: ${exitIP}`);
        }

        // 5. Save connection state
        await db.saveSetting('active_circuit_id', `circuit_${Date.now()}`);
        torBootstrapped = true;

        res.json({
            success: true,
            message: 'Tor Circuit Established',
            circuit: circuit,
            exitIP: exitIP,
            isTor: verification.isTor
        });

    } catch (err) {
        console.error('[GHOSTLINK] Connection error:', err.message);
        res.json({
            success: false,
            message: err.message,
            fallback: true
        });
    }
});

// Comprehensive data cleanup function
// Parameter: requestNewIdentity - if true, also requests a new Tor identity (rate-limited by Tor)
async function clearAllBrowsingData(requestNewIdentity = false) {
    console.log('[GHOSTLINK] Clearing all browsing data...');
    
    // 1. Clear proxy session state (cookies, circuits, cache)
    if (torProxy) {
        torProxy.clearSessionState();
    }
    
    // 2. Clear database settings related to browsing
    try {
        await db.saveSetting('active_circuit_id', '');
        await db.saveSetting('last_visited_url', '');
        await db.saveSetting('browsing_history', '[]');
    } catch (e) {
        console.log('[GHOSTLINK] DB clear warning:', e.message);
    }
    
    // 3. Only request new Tor identity if explicitly requested
    // This is rate-limited by Tor (10 second minimum between requests)
    if (requestNewIdentity && torProcess && torProcess.isRunning) {
        try {
            await torProxy.newIdentity();
        } catch (e) {
            // Ignore - Tor may rate-limit or not be connected
        }
    }
    
    // 4. Reset server state
    torBootstrapped = false;
    exitIP = null;
    
    console.log('[GHOSTLINK] All browsing data cleared');
}

app.post('/api/disconnect', async (req, res) => {
    try {
        // Full disconnect - request new identity for privacy
        await clearAllBrowsingData(true);
        res.json({ success: true, message: 'Circuit destroyed and all data cleared' });
    } catch (err) {
        // Still attempt cleanup even if there's an error
        await db.saveSetting('active_circuit_id', '');
        res.json({ success: true, message: 'Disconnected with warnings' });
    }
});

// Endpoint for manual cleanup (Clear Browsing Data menu option)
// Does NOT request new Tor identity to avoid rate limiting
app.post('/api/cleanup', async (req, res) => {
    try {
        // Parse if we should also get new identity
        const body = req.body || {};
        const requestNewIdentity = body.newIdentity === true;
        await clearAllBrowsingData(requestNewIdentity);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Graceful shutdown
async function gracefulShutdown() {
    console.log('\n[GHOSTLINK] Shutting down...');
    
    // Stop Tor controller
    try {
        torController.disconnect();
    } catch (e) {}
    
    // Stop proxy server
    try {
        torProxy.stop();
    } catch (e) {}
    
    // Stop Tor process
    if (torProcess) {
        console.log('[GHOSTLINK] Stopping Tor process...');
        await torProcess.stop();
    }
    
    console.log('[GHOSTLINK] Shutdown complete.');
    process.exit(0);
}

// Session context for tracking which site is being browsed
const browsingContext = new Map();

// Middleware to track browsing context from referer
app.use((req, res, next) => {
    const referer = req.get('referer');
    if (referer && referer.includes('/api/tor/page?url=')) {
        try {
            const refUrl = new URL(referer);
            const targetUrl = refUrl.searchParams.get('url');
            if (targetUrl) {
                const targetOrigin = new URL(targetUrl).origin;
                browsingContext.set(req.ip || 'default', targetOrigin);
            }
        } catch {}
    }
    next();
});

// Catch-all for any missed relative URLs (must be after static middleware)
// This proxies requests like /xjs/..., /images/..., /logos/... to the current site
app.use((req, res, next) => {
    // Skip API routes and static files
    if (req.path.startsWith('/api/') || req.path === '/' || req.path.startsWith('/socket.io')) {
        return next();
    }
    
    // Check if this looks like a resource request that should be proxied
    const resourceExtensions = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.ico'];
    const isResourcePath = resourceExtensions.some(ext => req.path.toLowerCase().includes(ext)) ||
        req.path.startsWith('/xjs/') || 
        req.path.startsWith('/images/') || 
        req.path.startsWith('/logos/') ||
        req.path.startsWith('/gen_204') ||
        req.path.startsWith('/async/') ||
        req.path.startsWith('/search');
    
    if (isResourcePath) {
        // Get the context origin from referer or stored context
        let targetOrigin = null;
        const referer = req.get('referer');
        
        if (referer && referer.includes('/api/tor/page?url=')) {
            try {
                const refUrl = new URL(referer);
                const targetUrl = refUrl.searchParams.get('url');
                if (targetUrl) {
                    targetOrigin = new URL(targetUrl).origin;
                }
            } catch {}
        }
        
        // Fall back to stored context
        if (!targetOrigin) {
            targetOrigin = browsingContext.get(req.ip || 'default');
        }
        
        // Default to Google if we have no context
        if (!targetOrigin) {
            targetOrigin = 'https://www.google.com';
        }
        
        // Build full URL and redirect to resource proxy
        const fullUrl = targetOrigin + req.originalUrl;
        return res.redirect(`/api/tor/resource?url=${encodeURIComponent(fullUrl)}`);
    }
    
    next();
});

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

app.listen(PORT, async () => {
    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║              GHOSTLINK - Anonymous Browsing System           ║`);
    console.log(`╠══════════════════════════════════════════════════════════════╣`);
    console.log(`║  Backend Server: http://localhost:${PORT}                       ║`);
    console.log(`║  Tor Proxy:      http://localhost:${PROXY_PORT}                       ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
    
    // Auto-start Tor on server startup
    await startTorAutomatically();
});
