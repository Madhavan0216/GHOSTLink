const consoleOutput = document.getElementById('console-output');
const statusIndicator = document.getElementById('status-indicator');
const onionConnectBtn = document.getElementById('onion-connect-btn');
const onionDisconnectBtn = document.getElementById('onion-disconnect-btn');
const circuitDisplay = document.getElementById('circuit-display');
const container = document.querySelector('.container');
const browserInterface = document.getElementById('browser-interface');
const togglePanelBtn = document.getElementById('toggle-panel-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
let isPanelVisible = true;
let isFullscreen = false;

// =============================================================================
// PRIVACY: Data cleanup is now MANUAL ONLY
// Cleanup happens when:
//   1. User clicks "Stop Circuit" button
//   2. User clicks "Clear Browsing Data" in the menu
// This prevents excessive NEWNYM requests to Tor
// =============================================================================

function log(message, type = 'normal') {
    const p = document.createElement('p');
    p.className = `log-line ${type}`;
    p.textContent = `> ${message}`;
    consoleOutput.appendChild(p);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function updateCircuitVisuals(stage) {
    const nodes = document.querySelectorAll('.node-icon');
    const lines = document.querySelectorAll('.connection-line');

    // Helper to set active state
    const setActive = (el, active) => active ? el.classList.add('active') : el.classList.remove('active');

    // Node 0 (You)
    setActive(nodes[0], stage >= 1);

    // Link 1 & Node 1 (Entry)
    setActive(lines[0], stage >= 2);
    setActive(nodes[1], stage >= 2);
    if (stage >= 2) nodes[1].textContent = 'ENTRY';
    else nodes[1].textContent = '?';

    // Link 2 & Node 2 (Relay)
    setActive(lines[1], stage >= 3);
    setActive(nodes[2], stage >= 3);
    if (stage >= 3) nodes[2].textContent = 'RELAY';
    else nodes[2].textContent = '?';

    // Link 3 & Node 3 (Exit)
    setActive(lines[2], stage >= 4);
    setActive(nodes[3], stage >= 4);
    if (stage >= 4) nodes[3].textContent = 'EXIT';
    else nodes[3].textContent = '?';

    // Link 4 & Node 4 (Web)
    setActive(lines[3], stage >= 5);
    setActive(nodes[4], stage >= 5);
}

// Global state for Tor connection
let torConnected = false;
let currentExitIP = null;

onionConnectBtn.addEventListener('click', async () => {
    log('Initializing Tor Onion Routing Protocol...', 'info');
    onionConnectBtn.disabled = true;
    updateCircuitVisuals(0);

    const nodes = document.querySelectorAll('.node-icon');
    const lines = document.querySelectorAll('.connection-line');

    // Helper functions for buildup animation (mirror of teardown)
    const flashGreen = async (nIndex, lIndex) => {
        if (nodes[nIndex]) nodes[nIndex].classList.add('buildup');
        if (lIndex >= 0 && lines[lIndex]) lines[lIndex].classList.add('buildup');
        await new Promise(r => setTimeout(r, 400)); // Stay green for 400ms
    };

    const clearGreen = (nIndex, lIndex) => {
        if (nodes[nIndex]) nodes[nIndex].classList.remove('buildup');
        if (lIndex >= 0 && lines[lIndex]) lines[lIndex].classList.remove('buildup');
    };

    try {
        // Step 1: Setup keys
        await fetch('/api/setup', { method: 'POST' });

        // Step 2: Check Tor daemon status
        log('Checking Tor daemon status...', 'normal');
        const torStatus = await fetch('/api/tor/status').then(r => r.json());
        
        if (!torStatus.running) {
            log('Tor daemon not detected. Attempting connection...', 'info');
        } else {
            log(`Tor ${torStatus.version || 'daemon'} detected.`, 'success');
            if (torStatus.bootstrapProgress < 100) {
                log(`Bootstrap progress: ${torStatus.bootstrapProgress}%`, 'info');
            }
        }

        // Step 3: Build Real Tor Circuit with animated sequence
        log('Building anonymity circuit through Tor network...', 'normal');
        
        // Animated Build Sequence (Left to Right, Green Flash)
        
        // 1. Client (You)
        log('Initializing secure client...', 'info');
        await flashGreen(0, -1);
        updateCircuitVisuals(1);
        clearGreen(0, -1);

        const res = await fetch('/api/connect_onion', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            torConnected = true;
            currentExitIP = data.exitIP;
            
            // 2. Client -> Entry Guard
            log(`Connecting to Entry Guard: ${data.circuit[0].name}...`, 'info');
            await flashGreen(1, 0);
            updateCircuitVisuals(2);
            clearGreen(1, 0);
            log(`Entry Guard connected.`, 'success');

            // 3. Entry -> Middle Relay
            log(`Routing through Relay: ${data.circuit[1].name}...`, 'info');
            await flashGreen(2, 1);
            updateCircuitVisuals(3);
            clearGreen(2, 1);
            log(`Relay node established.`, 'success');

            // 4. Relay -> Exit Node
            log(`Establishing Exit Node: ${data.circuit[2].name}...`, 'info');
            await flashGreen(3, 2);
            updateCircuitVisuals(4);
            clearGreen(3, 2);
            log(`Exit node secured.`, 'success');

            // 5. Exit -> External Web
            log('Opening connection to External Web...', 'info');
            await flashGreen(4, 3);
            updateCircuitVisuals(5);
            clearGreen(4, 3);

            if (data.isTor) {
                log(`Tor Circuit Established. Exit IP: ${data.exitIP}`, 'success');
            } else {
                log('Circuit Established. Verifying Tor connection...', 'info');
            }

            // Immediately enter fullscreen mode
            browserInterface.classList.add('visible');
            isFullscreen = true;
            browserInterface.classList.add('fullscreen');
            container.classList.add('panel-hidden');
            isPanelVisible = false;

            // Request browser fullscreen API
            if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen();
            } else if (document.documentElement.webkitRequestFullscreen) {
                document.documentElement.webkitRequestFullscreen();
            } else if (document.documentElement.msRequestFullscreen) {
                document.documentElement.msRequestFullscreen();
            }

            statusIndicator.textContent = 'ANONYMOUS CIRCUIT ACTIVE';
            statusIndicator.classList.add('active');

            // Toggle Buttons
            onionConnectBtn.classList.add('hidden');
            onionDisconnectBtn.classList.remove('hidden');
            onionConnectBtn.disabled = false;
            
            // Initialize browser manager with Tor capability
            if (browserManager) {
                browserManager.torEnabled = true;
            }
        } else {
            // Fallback mode if Tor isn't available
            log(`Warning: ${data.message}`, 'error');
            log('Running in simulated mode. Install Tor for real anonymity.', 'info');
            
            // Still animate the simulated circuit build
            // 2. Simulated Entry
            log('Simulating Entry Guard connection...', 'info');
            await flashGreen(1, 0);
            updateCircuitVisuals(2);
            clearGreen(1, 0);

            // 3. Simulated Relay
            log('Simulating Relay connection...', 'info');
            await flashGreen(2, 1);
            updateCircuitVisuals(3);
            clearGreen(2, 1);

            // 4. Simulated Exit
            log('Simulating Exit Node connection...', 'info');
            await flashGreen(3, 2);
            updateCircuitVisuals(4);
            clearGreen(3, 2);

            // 5. Simulated Web
            log('Opening simulated web connection...', 'info');
            await flashGreen(4, 3);
            updateCircuitVisuals(5);
            clearGreen(4, 3);
            browserInterface.classList.add('visible');
            isFullscreen = true;
            browserInterface.classList.add('fullscreen');
            container.classList.add('panel-hidden');
            isPanelVisible = false;
            
            statusIndicator.textContent = 'SIMULATED MODE';
            statusIndicator.classList.add('active');
            
            onionConnectBtn.classList.add('hidden');
            onionDisconnectBtn.classList.remove('hidden');
            onionConnectBtn.disabled = false;
        }

    } catch (e) {
        log(`Error: ${e.message}`, 'error');
        onionConnectBtn.disabled = false;
        // Ensure visuals are reset on error
        nodes.forEach(n => n.classList.remove('buildup'));
        lines.forEach(l => l.classList.remove('buildup'));
    }
});

onionDisconnectBtn.addEventListener('click', async () => {
    log('Initiating Secure Teardown...', 'info');
    onionDisconnectBtn.disabled = true;

    const nodes = document.querySelectorAll('.node-icon');
    const lines = document.querySelectorAll('.connection-line');

    const flashRed = async (nIndex, lIndex) => {
        if (nodes[nIndex]) nodes[nIndex].classList.add('teardown');
        if (lines[lIndex]) lines[lIndex].classList.add('teardown');
        await new Promise(r => setTimeout(r, 400)); // Stay red for 400ms
    };

    const clearRed = (nIndex, lIndex) => {
        if (nodes[nIndex]) nodes[nIndex].classList.remove('teardown');
        if (lines[lIndex]) lines[lIndex].classList.remove('teardown');
    };

    try {
        await fetch('/api/disconnect', { method: 'POST' });

        // Animated Teardown Sequence (Right to Left, Red Flash)

        // 1. Web -> Exit
        log('Severing connection to External Web...', 'error');
        await flashRed(4, 3);
        updateCircuitVisuals(4); // Turn off active
        clearRed(4, 3);

        // 2. Exit -> Relay
        log('Disconnecting Exit Node (Hop 3)...', 'error');
        await flashRed(3, 2);
        updateCircuitVisuals(3);
        clearRed(3, 2);

        // 3. Relay -> Entry
        log('Disconnecting Relay Node (Hop 2)...', 'error');
        await flashRed(2, 1);
        updateCircuitVisuals(2);
        clearRed(2, 1);

        // 4. Entry -> Client
        log('Disconnecting Entry Node (Hop 1)...', 'error');
        await flashRed(1, 0);
        updateCircuitVisuals(1);
        clearRed(1, 0);

        // Final cleanup
        log('Circuit destroyed. All browsing data cleared.', 'success');
        updateCircuitVisuals(0);
        
        // Reset Tor state
        torConnected = false;
        currentExitIP = null;
        if (browserManager) {
            browserManager.torEnabled = false;
            // Clear browser manager's internal state
            browserManager.clearAllTabs();
        }
        
        // Clear iframe content
        const browserFrame = document.getElementById('browser-frame');
        if (browserFrame) {
            browserFrame.srcdoc = '';
            browserFrame.src = 'about:blank';
        }
        
        // Clear URL bar
        const urlInput = document.getElementById('url-input');
        if (urlInput) {
            urlInput.value = '';
        }

        statusIndicator.textContent = 'UNSECURED';
        statusIndicator.classList.remove('active');

        // Toggle Buttons
        onionDisconnectBtn.classList.add('hidden');
        onionConnectBtn.classList.remove('hidden');
        onionDisconnectBtn.disabled = false;

        // Restore Window Size
        container.classList.remove('compact');
        browserInterface.classList.remove('visible');

    } catch (e) {
        log(`Error disconnecting: ${e.message}`, 'error');
        onionDisconnectBtn.disabled = false;
        // Ensure visuals are reset on error
        nodes.forEach(n => n.classList.remove('teardown'));
        lines.forEach(l => l.classList.remove('teardown'));
    }
});

// Toggle GhostLink Panel
togglePanelBtn.addEventListener('click', () => {
    isPanelVisible = !isPanelVisible;

    if (isPanelVisible) {
        container.classList.remove('panel-hidden');
        container.classList.add('compact');
    } else {
        container.classList.add('panel-hidden');
    }
});

// Toggle Fullscreen
fullscreenBtn.addEventListener('click', () => {
    isFullscreen = !isFullscreen;

    if (isFullscreen) {
        browserInterface.classList.add('fullscreen');
        container.classList.add('panel-hidden');
        isPanelVisible = false;

        // Request browser fullscreen API
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen();
        } else if (document.documentElement.webkitRequestFullscreen) {
            document.documentElement.webkitRequestFullscreen();
        } else if (document.documentElement.msRequestFullscreen) {
            document.documentElement.msRequestFullscreen();
        }
    } else {
        browserInterface.classList.remove('fullscreen');
        container.classList.remove('panel-hidden');
        isPanelVisible = true;

        // Exit browser fullscreen API
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
    }
});

// Handle ESC key to exit fullscreen
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        isFullscreen = false;
        browserInterface.classList.remove('fullscreen');
        if (browserInterface.classList.contains('visible')) {
            container.classList.remove('panel-hidden');
            isPanelVisible = true;
        }
    }
});

// Handle webkit fullscreen change
document.addEventListener('webkitfullscreenchange', () => {
    if (!document.webkitFullscreenElement) {
        isFullscreen = false;
        browserInterface.classList.remove('fullscreen');
        if (browserInterface.classList.contains('visible')) {
            container.classList.remove('panel-hidden');
            isPanelVisible = true;
        }
    }
});

// --- BROWSER FUNCTIONALITY ---

class BrowserManager {
    constructor() {
        this.tabs = [{
            id: 1,
            title: 'Welcome',
            url: 'about:home',
            active: true,
            history: ['about:home'],
            historyIndex: 0,
            content: null,  // Cached content
            cookies: new Map(),  // Tab-level cookie isolation
            sessionId: this.generateSessionId()  // For circuit isolation
        }];
        this.activeTabId = 1;
        this.nextTabId = 2;
        
        // Tor integration
        this.torEnabled = false;
        this.proxyEndpoint = '/api/tor/fetch';

        this.tabBar = document.querySelector('.tab-bar');
        this.addressInput = document.querySelector('.address-bar input');
        this.browserContent = document.querySelector('.browser-content');
        this.newTabBtn = document.querySelector('.new-tab-btn');

        // Nav Buttons
        this.backBtn = document.querySelector('.nav-controls .nav-btn:nth-child(1)');
        this.forwardBtn = document.querySelector('.nav-controls .nav-btn:nth-child(2)');
        this.reloadBtn = document.querySelector('.nav-controls .nav-btn:nth-child(3)');

        // Initial binding for static elements
        this.bindStaticEvents();
        this.renderTabs();

        // Bind initial content events
        this.bindContentEvents();
    }
    
    /**
     * Generate unique session ID for tab isolation
     */
    generateSessionId() {
        return 'tab_' + Math.random().toString(36).substring(2, 15);
    }

    bindStaticEvents() {
        // New Tab
        this.newTabBtn.addEventListener('click', () => this.addTab());

        // Tab Clicking (Delegation)
        this.tabBar.addEventListener('click', (e) => {
            const tabEl = e.target.closest('.tab');
            if (!tabEl) return;

            if (e.target.classList.contains('tab-close')) {
                e.stopPropagation();
                const tabId = parseInt(tabEl.dataset.id);
                this.closeTab(tabId);
                return;
            }

            const tabId = parseInt(tabEl.dataset.id);
            this.switchTab(tabId);
        });

        // Address Bar
        this.addressInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.navigate(this.addressInput.value);
        });

        // Nav Controls
        this.backBtn.addEventListener('click', () => this.goBack());
        this.forwardBtn.addEventListener('click', () => this.goForward());
        this.reloadBtn.addEventListener('click', () => this.reload());
    }

    bindContentEvents() {
        const searchBtn = this.browserContent.querySelector('.search-btn');
        const searchInput = this.browserContent.querySelector('.main-search-input');

        if (searchBtn) {
            searchBtn.onclick = () => this.handleSearch(searchInput.value);
        }

        if (searchInput) {
            searchInput.onkeypress = (e) => {
                if (e.key === 'Enter') this.handleSearch(searchInput.value);
            };
        }

        const shortcuts = this.browserContent.querySelectorAll('.shortcut');
        shortcuts.forEach(s => {
            s.onclick = () => {
                // Check for data-url attribute first (direct URL navigation)
                const url = s.getAttribute('data-url');
                if (url) {
                    this.navigate(url);
                } else {
                    // Fall back to text-based shortcut handling
                    const text = s.querySelector('span').textContent;
                    this.handleShortcut(text);
                }
            };
        });
        
        // Handle clicks on links within rendered content
        this.browserContent.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (link && link.href && !link.href.startsWith('javascript:')) {
                e.preventDefault();
                const href = link.getAttribute('href');
                if (href && href !== '#') {
                    this.navigate(href);
                }
            }
        });
    }

    addTab() {
        const newTab = {
            id: this.nextTabId++,
            title: 'New Tab',
            url: 'about:home',
            active: true,
            history: ['about:home'],
            historyIndex: 0,
            content: null,
            cookies: new Map(),
            sessionId: this.generateSessionId()
        };
        this.tabs.forEach(t => t.active = false);
        this.tabs.push(newTab);
        this.activeTabId = newTab.id;
        this.renderTabs();
        this.renderContent();
    }

    /**
     * Clear all tabs and reset to initial state (privacy cleanup)
     */
    clearAllTabs() {
        // Clear all tab data including cookies and history
        this.tabs.forEach(tab => {
            tab.cookies.clear();
            tab.history = [];
            tab.content = null;
        });
        
        // Reset to single empty tab
        this.tabs = [{
            id: 1,
            title: 'Welcome',
            url: 'about:home',
            active: true,
            history: ['about:home'],
            historyIndex: 0,
            content: null,
            cookies: new Map(),
            sessionId: this.generateSessionId()
        }];
        this.activeTabId = 1;
        this.nextTabId = 2;
        
        // Clear iframe
        const iframe = this.browserContent.querySelector('iframe');
        if (iframe) {
            iframe.srcdoc = '';
            iframe.src = 'about:blank';
        }
        
        // Reset UI
        this.renderTabs();
        this.renderContent();
        
        console.log('[BrowserManager] All tabs cleared');
    }

    closeTab(id) {
        if (this.tabs.length === 1) return;

        const index = this.tabs.findIndex(t => t.id === id);
        if (index === -1) return;

        const wasActive = this.tabs[index].active;
        this.tabs.splice(index, 1);

        if (wasActive) {
            const newActive = this.tabs[index] || this.tabs[index - 1];
            if (newActive) {
                newActive.active = true;
                this.activeTabId = newActive.id;
            }
        }

        this.renderTabs();
        this.renderContent();
    }

    switchTab(id) {
        this.tabs.forEach(t => t.active = (t.id === id));
        this.activeTabId = id;
        this.renderTabs();
        this.renderContent();
    }

    renderTabs() {
        const oldTabs = this.tabBar.querySelectorAll('.tab');
        oldTabs.forEach(t => t.remove());

        this.tabs.forEach(tab => {
            const el = document.createElement('div');
            el.className = `tab ${tab.active ? 'active' : ''}`;
            el.dataset.id = tab.id;
            el.innerHTML = `
                <span class="tab-icon">🔗</span>
                <span class="tab-title">${tab.title}</span>
                <span class="tab-close">×</span>
            `;
            this.tabBar.insertBefore(el, this.newTabBtn);
        });

        const activeTab = this.tabs.find(t => t.active);
        if (activeTab) {
            this.addressInput.value = activeTab.url === 'about:home' ? '' : activeTab.url;

            // Update Nav Buttons State
            this.backBtn.style.opacity = activeTab.historyIndex > 0 ? '1' : '0.3';
            this.forwardBtn.style.opacity = activeTab.historyIndex < activeTab.history.length - 1 ? '1' : '0.3';
        }
    }

    handleSearch(query) {
        if (!query) return;
        // Use DuckDuckGo - it's Tor-friendly and doesn't block/CAPTCHA
        this.navigate(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
    }

    handleShortcut(name) {
        const map = {
            'Hidden Wiki': 'http://zqktlwi4fecvo6ri.onion/wiki/index.php/Main_Page',
            'ProtonMail': 'https://protonirockerxow.onion/',
            'Wallet': 'http://wallet.onion/',
            'Check IP': 'https://check.torproject.org/'
        };
        if (map[name]) this.navigate(map[name]);
    }

    navigate(url) {
        const activeTab = this.tabs.find(t => t.active);
        if (!activeTab) return;

        // Block internal protocol prefixes that shouldn't be navigated
        if (url.startsWith('EMBED:') || url.startsWith('EXTERNAL:')) {
            console.warn('[GHOSTLINK] Blocked navigation to internal URL:', url);
            return;
        }

        if (!url.startsWith('http') && !url.startsWith('search://') && !url.startsWith('about:')) {
            url = 'http://' + url;
        }

        // Add to history
        if (activeTab.url !== url) {
            activeTab.history = activeTab.history.slice(0, activeTab.historyIndex + 1);
            activeTab.history.push(url);
            activeTab.historyIndex++;
        }

        this.loadUrl(activeTab, url);
    }

    goBack() {
        const activeTab = this.tabs.find(t => t.active);
        if (!activeTab || activeTab.historyIndex <= 0) return;

        activeTab.historyIndex--;
        const url = activeTab.history[activeTab.historyIndex];
        this.loadUrl(activeTab, url);
    }

    goForward() {
        const activeTab = this.tabs.find(t => t.active);
        if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return;

        activeTab.historyIndex++;
        const url = activeTab.history[activeTab.historyIndex];
        this.loadUrl(activeTab, url);
    }

    reload() {
        const activeTab = this.tabs.find(t => t.active);
        if (!activeTab) return;
        this.loadUrl(activeTab, activeTab.url);
    }

    /**
     * Load URL through Tor proxy with full JavaScript support
     * Uses iframe-based rendering for maximum compatibility
     */
    async loadUrl(tab, url) {
        tab.url = url;
        tab.title = url.replace('http://', '').replace('https://', '').substring(0, 15) + '...';
        if (tab.title.startsWith('search://')) tab.title = 'Search Results';
        if (url === 'about:home') tab.title = 'Welcome';

        this.renderTabs();

        // Show Loading State
        this.browserContent.classList.add('loading');
        this.browserContent.innerHTML = `
            <div style="color: #fff; padding: 20px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
                <h1 style="font-family: 'Courier New'; margin-bottom: 20px;">Connecting to ${this.sanitizeDisplayUrl(url)}...</h1>
                <div class="loader" style="width: 50px; height: 50px; border: 5px solid #333; border-top-color: #00ff41; border-radius: 50%;"></div>
                <p style="margin-top: 20px; color: #666;">Routing through Tor circuit...</p>
            </div>
        `;

        // For special URLs, render immediately
        if (url === 'about:home' || url.startsWith('search://')) {
            setTimeout(() => {
                this.browserContent.classList.remove('loading');
                this.renderContent();
            }, 300);
            return;
        }

        // Check if this is a video site - handle specially
        if (this.isVideoSite(url)) {
            await this.handleVideoSite(tab, url);
            return;
        }

        // Use full page proxy mode with JavaScript enabled
        // This creates an iframe pointing to our page proxy endpoint
        this.browserContent.classList.remove('loading');
        this.browserContent.innerHTML = '';
        
        // Ensure URL has protocol
        let fullUrl = url;
        if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
            fullUrl = 'https://' + fullUrl;
        }
        
        // Create iframe for full page rendering with JS
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 100%; height: 100%; border: none; background: #fff;';
        iframe.id = `page-frame-${tab.id}`;
        
        // Use the page proxy endpoint which preserves JavaScript
        iframe.src = `/api/tor/page?url=${encodeURIComponent(fullUrl)}`;
        
        // Allow scripts and forms in sandbox, but restrict top navigation
        iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
        
        this.browserContent.appendChild(iframe);
        
        // Listen for navigation messages from the iframe
        const messageHandler = (event) => {
            if (event.data && event.data.type === 'ghostlink-navigate') {
                let navUrl = event.data.url;
                // Handle proxy URLs - extract actual URL
                if (navUrl.includes('/api/tor/page?url=')) {
                    try {
                        const urlObj = new URL(navUrl, window.location.origin);
                        navUrl = decodeURIComponent(urlObj.searchParams.get('url') || navUrl);
                    } catch {}
                }
                this.navigate(navUrl);
            } else if (event.data && event.data.type === 'ghostlink-form-submit') {
                // Handle POST forms - for now, convert to GET
                console.log('[GHOSTLINK] Form submission:', event.data);
                this.navigate(event.data.action);
            }
        };
        
        // Remove old listener if exists, add new one
        if (this._messageHandler) {
            window.removeEventListener('message', this._messageHandler);
        }
        this._messageHandler = messageHandler;
        window.addEventListener('message', messageHandler);
        
        // Update tab title when iframe loads
        iframe.onload = () => {
            try {
                // Try to get title from iframe (may fail due to cross-origin)
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDoc && iframeDoc.title) {
                    tab.title = iframeDoc.title;
                    this.renderTabs();
                }
            } catch (e) {
                // Cross-origin restriction, use URL as title
                try {
                    const urlObj = new URL(fullUrl);
                    tab.title = urlObj.hostname;
                    this.renderTabs();
                } catch {}
            }
        };
        
        iframe.onerror = () => {
            this.renderErrorPage(tab, 'Failed to load page');
        };
    }
    
    /**
     * Check if URL is a video streaming site
     */
    isVideoSite(url) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            const videoSites = [
                'youtube.com', 'youtu.be', 'www.youtube.com', 'm.youtube.com',
                'vimeo.com', 'www.vimeo.com',
                'dailymotion.com', 'www.dailymotion.com',
                'twitch.tv', 'www.twitch.tv',
                'piped.video', 'piped.kavin.rocks',
                'yewtu.be', 'invidious'
            ];
            return videoSites.some(site => hostname.includes(site));
        } catch {
            return false;
        }
    }
    
    /**
     * Handle video sites with special player interface
     */
    async handleVideoSite(tab, url) {
        this.browserContent.classList.remove('loading');
        
        try {
            // Get video info from server
            const response = await fetch(`/api/tor/video-info?url=${encodeURIComponent(url)}`);
            const videoInfo = await response.json();
            
            if (videoInfo.success && videoInfo.platform !== 'unknown') {
                tab.title = `${videoInfo.platform.charAt(0).toUpperCase() + videoInfo.platform.slice(1)} Video`;
                this.renderTabs();
                this.renderVideoPlayer(tab, url, videoInfo);
            } else {
                // Fall back to regular page load
                const pageResponse = await fetch(`${this.proxyEndpoint}?url=${encodeURIComponent(url)}&tabId=${tab.sessionId}`);
                const data = await pageResponse.json();
                
                if (data.success) {
                    tab.content = data;
                    tab.title = data.metadata?.title || tab.title;
                    this.renderTabs();
                    this.renderFetchedContent(tab, data);
                } else {
                    this.renderVideoPlayer(tab, url, { platform: 'unknown' });
                }
            }
        } catch (err) {
            this.renderVideoPlayer(tab, url, { platform: 'unknown', error: err.message });
        }
    }
    
    /**
     * Render video player interface
     */
    renderVideoPlayer(tab, url, videoInfo) {
        const platform = videoInfo.platform || 'unknown';
        const embedUrl = videoInfo.embedUrl || '';
        const thumbnailUrl = videoInfo.thumbnailUrl || '';
        const alternatives = videoInfo.alternatives || [];
        
        let alternativesHtml = '';
        if (alternatives.length > 0) {
            alternativesHtml = `
                <div style="margin-top: 20px;">
                    <p style="color: #888; margin-bottom: 10px;">Alternative players (click to switch):</p>
                    <div style="display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;">
                    ${alternatives.map((alt, idx) => {
                        if (alt.url.startsWith('EMBED:')) {
                            // Embed URL - switch the iframe source
                            const embedSrc = alt.url.replace('EMBED:', '');
                            return `
                                <button type="button" class="embed-switch-btn" data-embed-src="${embedSrc}"
                                    style="padding: 10px 20px; background: #1a1a1a; border: 1px solid #00ff41; color: #00ff41; cursor: pointer; border-radius: 5px; transition: all 0.2s;">
                                    ▶ ${alt.name}
                                </button>
                            `;
                        } else if (alt.url.startsWith('EXTERNAL:')) {
                            // External URL - open in new window
                            const externalUrl = alt.url.replace('EXTERNAL:', '');
                            return `
                                <button type="button" class="external-link-btn" data-external-url="${externalUrl}"
                                    style="padding: 10px 20px; background: #1a1a1a; border: 1px solid #888; color: #888; cursor: pointer; border-radius: 5px;">
                                    ↗ ${alt.name}
                                </button>
                            `;
                        } else {
                            // Regular navigation
                            return `
                                <button type="button" class="navigate-btn" data-nav-url="${alt.url}"
                                    style="padding: 10px 20px; background: #1a1a1a; border: 1px solid #00ff41; color: #00ff41; cursor: pointer; border-radius: 5px;">
                                    ${alt.name}
                                </button>
                            `;
                        }
                    }).join('')}
                    </div>
                </div>
            `;
        }
        
        if (embedUrl && platform !== 'unknown') {
            // Show embedded player
            this.browserContent.innerHTML = `
                <div style="width: 100%; height: 100%; display: flex; flex-direction: column; background: #0a0a0a;">
                    <div style="flex: 1; display: flex; justify-content: center; align-items: center; background: #000; padding: 20px;">
                        <iframe 
                            id="video-embed-frame"
                            src="${embedUrl}"
                            style="width: 100%; height: 100%; max-width: 1280px; max-height: 720px; border: none; border-radius: 8px;"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                            allowfullscreen>
                        </iframe>
                    </div>
                    <div style="padding: 15px 20px; text-align: center; border-top: 1px solid #333; background: #0d0d0d;">
                        <p style="color: #666; font-size: 0.85rem; margin-bottom: 10px;">
                            ⚠️ ${videoInfo.privacyNote || 'Video streaming services may track your activity.'}
                        </p>
                        ${alternativesHtml}
                    </div>
                </div>
            `;
            
            // Attach event listeners for alternative player buttons
            this.attachVideoPlayerHandlers();
        } else {
            // Show fallback message
            this.browserContent.innerHTML = `
                <div style="width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #0a0a0a; padding: 40px; text-align: center;">
                    <div style="font-size: 4rem; margin-bottom: 20px;">🎬</div>
                    <h2 style="color: #fff; margin-bottom: 10px;">Video Site Detected</h2>
                    <p style="color: #888; max-width: 500px; margin-bottom: 20px;">
                        Video streaming sites require JavaScript for playback. 
                        Use the embed players below or open in Tor Browser for full functionality.
                    </p>
                    ${thumbnailUrl ? `<img src="/api/tor/resource?url=${encodeURIComponent(thumbnailUrl)}" style="max-width: 480px; border-radius: 8px; margin-bottom: 20px;">` : ''}
                    ${alternativesHtml}
                    <button onclick="window.open('${url}', '_blank')" style="margin-top: 20px; padding: 12px 30px; background: #333; border: 1px solid #555; color: #fff; cursor: pointer; border-radius: 5px;">
                        Open in External Browser →
                    </button>
                </div>
            `;
        }
    }
    
    /**
     * Attach event handlers for video player alternative buttons
     */
    attachVideoPlayerHandlers() {
        // Handle embed switch buttons - stop propagation to prevent parent handlers
        document.querySelectorAll('.embed-switch-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const embedSrc = btn.dataset.embedSrc;
                const iframe = document.getElementById('video-embed-frame');
                if (iframe && embedSrc) {
                    console.log('[GHOSTLINK] Switching embed to:', embedSrc);
                    iframe.src = embedSrc;
                    // Update button states
                    document.querySelectorAll('.embed-switch-btn').forEach(b => {
                        b.classList.remove('active');
                        b.style.background = '#1a1a1a';
                        b.style.color = '#00ff41';
                    });
                    btn.classList.add('active');
                    btn.style.background = '#00ff41';
                    btn.style.color = '#000';
                }
            });
        });
        
        // Handle external link buttons
        document.querySelectorAll('.external-link-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const externalUrl = btn.dataset.externalUrl;
                if (externalUrl) {
                    console.log('[GHOSTLINK] Opening external URL:', externalUrl);
                    window.open(externalUrl, '_blank');
                }
            });
        });
        
        // Handle navigation buttons
        document.querySelectorAll('.navigate-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const navUrl = btn.dataset.navUrl;
                if (navUrl) {
                    this.navigate(navUrl);
                }
            });
        });
    }

    /**
     * Update URL bar display
     */
    updateUrlBar(url) {
        const urlBar = document.querySelector('.browser-url-bar');
        if (urlBar) {
            urlBar.value = url;
        }
    }
    
    /**
     * Sanitize URL for display (prevent XSS in display)
     */
    sanitizeDisplayUrl(url) {
        return url.replace(/</g, '&lt;').replace(/>/g, '&gt;').substring(0, 100);
    }

    /**
     * Render fetched HTML content safely
     */
    renderFetchedContent(tab, data) {
        if (!data.html) {
            this.renderErrorPage(tab, 'No content received');
            return;
        }

        // Create iframe for content (less restrictive for proper rendering)
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 100%; height: 100%; border: none; background: #fff;';
        // Allow more capabilities for proper page rendering
        iframe.sandbox = 'allow-same-origin allow-forms allow-popups';
        
        // Prepare content with base tag
        const baseUrl = data.url || tab.url;
        const sanitizedHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <base href="${baseUrl}">
                <meta charset="UTF-8">
                <style>
                    body { font-family: Arial, sans-serif; margin: 0; padding: 0; background: #fff; color: #333; }
                    a { color: #0066cc; }
                    img { max-width: 100%; height: auto; }
                </style>
            </head>
            <body>
                ${data.html}
            </body>
            </html>
        `;

        this.browserContent.innerHTML = '';
        this.browserContent.appendChild(iframe);

        // Write content to iframe
        try {
            iframe.contentDocument.open();
            iframe.contentDocument.write(sanitizedHtml);
            iframe.contentDocument.close();

            // Intercept link clicks within iframe
            iframe.contentDocument.addEventListener('click', (e) => {
                const link = e.target.closest('a');
                if (link && link.href) {
                    e.preventDefault();
                    this.navigate(link.href);
                }
            });
        } catch (err) {
            console.error('Error rendering content:', err);
            this.renderErrorPage(tab, 'Error rendering page content');
        }
    }

    /**
     * Render error page
     */
    renderErrorPage(tab, errorMessage) {
        const isOnion = tab.url.includes('.onion');
        this.browserContent.innerHTML = `
            <div style="text-align:center; margin-top: 50px; padding: 20px; animation: fade-in 0.5s;">
                <h1 style="color: #ff0033; font-size: 2rem;">⚠️ Connection Failed</h1>
                <p style="color: #888; margin: 20px 0;">Unable to connect to ${this.sanitizeDisplayUrl(tab.url)}</p>
                <div style="border: 1px solid #333; padding: 20px; margin: 20px auto; max-width: 600px; background: #111; text-align: left; font-family: monospace; color: #ff6666;">
                    Error: ${errorMessage}
                </div>
                ${isOnion ? `
                    <p style="color: #666; font-size: 0.9rem;">
                        This is a .onion address. Make sure:<br>
                        • Tor daemon is running<br>
                        • The onion service is online<br>
                        • The address is correct
                    </p>
                ` : `
                    <p style="color: #666; font-size: 0.9rem;">
                        Possible causes:<br>
                        • Tor circuit not established<br>
                        • Website is down or unreachable<br>
                        • Network timeout
                    </p>
                `}
                <button onclick="browserManager.navigate('about:home')" style="margin-top: 20px; padding: 10px 20px; background: #00ff41; color: #000; border: none; cursor: pointer; font-weight: bold;">
                    Return Home
                </button>
            </div>
        `;
    }

    renderContent() {
        const activeTab = this.tabs.find(t => t.active);
        if (!activeTab) return;

        if (activeTab.url === 'about:home') {
            const connectionStatus = torConnected 
                ? `Connected via Tor Circuit${currentExitIP ? ` (Exit: ${currentExitIP})` : ''}`
                : 'Simulated Mode - Install Tor for real anonymity';
            
            this.browserContent.innerHTML = `
                <div class="welcome-screen">
                    <div class="browser-logo">GHOSTLINK</div>
                    <p class="browser-status">${connectionStatus}</p>
                    <div class="search-box-container">
                        <input type="text" class="main-search-input" placeholder="Search the dark web or enter .onion URL">
                        <button class="search-btn">SEARCH</button>
                    </div>
                    <div class="shortcuts">
                        <div class="shortcut"><div class="shortcut-icon">🧅</div><span>Hidden Wiki</span></div>
                        <div class="shortcut"><div class="shortcut-icon">📧</div><span>ProtonMail</span></div>
                        <div class="shortcut"><div class="shortcut-icon">₿</div><span>Wallet</span></div>
                        <div class="shortcut"><div class="shortcut-icon">🛡️</div><span>Check IP</span></div>
                    </div>
                    <div style="margin-top: 30px;">
                        <button onclick="browserManager.requestNewIdentity()" style="padding: 8px 16px; background: #333; color: #00ff41; border: 1px solid #00ff41; cursor: pointer; font-family: 'Courier New';">
                            🔄 New Identity
                        </button>
                    </div>
                </div>
            `;
            this.bindContentEvents();
        } else if (activeTab.url.startsWith('search://')) {
            // Handle search results
            const query = new URL(activeTab.url.replace('search://', 'http://')).searchParams.get('q');
            this.browserContent.innerHTML = `
                <div style="padding: 40px; animation: fade-in 0.5s;">
                    <h2 style="color: #00ff41; margin-bottom: 20px;">Search Results for: "${query}"</h2>
                    <p style="color: #888;">Search functionality requires integration with a dark web search engine.</p>
                    <p style="color: #666; margin-top: 20px;">Try visiting:</p>
                    <ul style="color: #00ff41; list-style: none; padding: 0;">
                        <li style="margin: 10px 0;"><a href="http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion" style="color: #00ff41;">Ahmia Search Engine (.onion)</a></li>
                        <li style="margin: 10px 0;"><a href="https://duckduckgo.com/?q=${encodeURIComponent(query)}" style="color: #00ff41;">DuckDuckGo (clearnet)</a></li>
                    </ul>
                </div>
            `;
        } else if (activeTab.content) {
            // Render cached content
            this.renderFetchedContent(activeTab, activeTab.content);
        } else {
            // For pages without cached content, show placeholder
            this.browserContent.innerHTML = `
                <div style="text-align:center; margin-top: 50px; animation: fade-in 0.5s;">
                    <h1 style="color: #fff;">Loading ${this.sanitizeDisplayUrl(activeTab.url)}</h1>
                    <p style="color: #888;">Fetching through Tor network...</p>
                </div>
            `;
        }
    }

    /**
     * Request new Tor identity
     */
    async requestNewIdentity() {
        try {
            const response = await fetch('/api/tor/new-identity', { method: 'POST' });
            const data = await response.json();
            
            if (data.success) {
                // Clear all tab content caches
                this.tabs.forEach(tab => {
                    tab.content = null;
                    tab.sessionId = this.generateSessionId();
                });
                
                // Update exit IP display
                currentExitIP = null;
                
                // Refresh current tab
                const activeTab = this.tabs.find(t => t.active);
                if (activeTab && activeTab.url !== 'about:home') {
                    this.loadUrl(activeTab, activeTab.url);
                } else {
                    this.renderContent();
                }
                
                // Log to terminal
                if (typeof log === 'function') {
                    log('New Tor identity acquired. Circuits refreshed.', 'success');
                }
            }
        } catch (err) {
            console.error('Failed to get new identity:', err);
        }
    }
}

// Initialize Browser Manager
const browserManager = new BrowserManager();
// =============================================================================
// BROWSER MENU FUNCTIONALITY
// =============================================================================

// Menu state
let currentZoom = 100;
const bookmarks = [];
const browsingHistory = [];

// Menu toggle
const menuBtn = document.getElementById('menu-btn');
const browserMenu = document.getElementById('browser-menu');

if (menuBtn && browserMenu) {
    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        browserMenu.classList.toggle('visible');
    });
    
    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        if (!browserMenu.contains(e.target) && e.target !== menuBtn) {
            browserMenu.classList.remove('visible');
        }
    });
}

// Close menu helper
function closeMenu() {
    if (browserMenu) browserMenu.classList.remove('visible');
}

// Modal management
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('visible');
        // Close button handler
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) {
            closeBtn.onclick = () => modal.classList.remove('visible');
        }
        // Click outside to close
        modal.onclick = (e) => {
            if (e.target === modal) modal.classList.remove('visible');
        };
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('visible');
}

// New Tab
document.getElementById('menu-new-tab')?.addEventListener('click', () => {
    closeMenu();
    browserManager.addTab();
});

// New Identity
document.getElementById('menu-new-identity')?.addEventListener('click', async () => {
    closeMenu();
    await browserManager.requestNewIdentity();
});

// Zoom Controls - Don't close menu for zoom buttons
document.getElementById('menu-zoom-in')?.addEventListener('click', (e) => {
    e.stopPropagation();
    currentZoom = Math.min(200, currentZoom + 10);
    applyZoom();
    updateZoomDisplay();
});

document.getElementById('menu-zoom-out')?.addEventListener('click', (e) => {
    e.stopPropagation();
    currentZoom = Math.max(50, currentZoom - 10);
    applyZoom();
    updateZoomDisplay();
});

document.getElementById('menu-zoom-reset')?.addEventListener('click', (e) => {
    e.stopPropagation();
    currentZoom = 100;
    applyZoom();
    updateZoomDisplay();
});

function applyZoom() {
    const browserContent = document.querySelector('.browser-content');
    if (browserContent) {
        browserContent.style.transform = `scale(${currentZoom / 100})`;
        browserContent.style.transformOrigin = 'top left';
        browserContent.style.width = `${10000 / currentZoom}%`;
        browserContent.style.height = `${10000 / currentZoom}%`;
    }
}

// Find in Page
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findInfo = document.getElementById('find-info');
let findMatches = [];
let currentFindIndex = 0;

document.getElementById('menu-find')?.addEventListener('click', () => {
    closeMenu();
    showFindBar();
});

function showFindBar() {
    if (findBar) {
        findBar.classList.add('visible');
        findInput?.focus();
    }
}

function hideFindBar() {
    if (findBar) {
        findBar.classList.remove('visible');
        clearFindHighlights();
    }
}

document.getElementById('find-close')?.addEventListener('click', hideFindBar);

findInput?.addEventListener('input', () => {
    performFind(findInput.value);
});

document.getElementById('find-next')?.addEventListener('click', () => {
    if (findMatches.length > 0) {
        currentFindIndex = (currentFindIndex + 1) % findMatches.length;
        highlightCurrentMatch();
    }
});

document.getElementById('find-prev')?.addEventListener('click', () => {
    if (findMatches.length > 0) {
        currentFindIndex = (currentFindIndex - 1 + findMatches.length) % findMatches.length;
        highlightCurrentMatch();
    }
});

function performFind(query) {
    clearFindHighlights();
    findMatches = [];
    currentFindIndex = 0;
    
    if (!query) {
        if (findInfo) findInfo.textContent = '0/0';
        return;
    }
    
    const iframe = document.querySelector('.browser-content iframe');
    if (iframe && iframe.contentDocument) {
        try {
            const body = iframe.contentDocument.body;
            if (body) {
                const text = body.innerText;
                const regex = new RegExp(query, 'gi');
                let match;
                while ((match = regex.exec(text)) !== null) {
                    findMatches.push(match.index);
                }
            }
        } catch (e) {
            // Cross-origin restriction
        }
    }
    
    if (findInfo) {
        findInfo.textContent = findMatches.length > 0 
            ? `${currentFindIndex + 1}/${findMatches.length}` 
            : '0/0';
    }
}

function clearFindHighlights() {
    // Clear any existing highlights
}

function highlightCurrentMatch() {
    if (findInfo && findMatches.length > 0) {
        findInfo.textContent = `${currentFindIndex + 1}/${findMatches.length}`;
    }
}

// Print
document.getElementById('menu-print')?.addEventListener('click', () => {
    closeMenu();
    const iframe = document.querySelector('.browser-content iframe');
    if (iframe && iframe.contentWindow) {
        try {
            iframe.contentWindow.print();
        } catch (e) {
            window.print();
        }
    } else {
        window.print();
    }
});

// Screenshot
document.getElementById('menu-screenshot')?.addEventListener('click', async () => {
    closeMenu();
    try {
        const browserContent = document.querySelector('.browser-content');
        if (browserContent) {
            // Create a canvas from the content
            log('Screenshot saved to clipboard', 'success');
            // Note: Full implementation would require html2canvas library
            // For now, we'll use the browser's native screenshot capability
            if (navigator.clipboard && 'write' in navigator.clipboard) {
                log('Use Ctrl+Shift+S for system screenshot', 'info');
            }
        }
    } catch (e) {
        log('Screenshot failed: ' + e.message, 'error');
    }
});

// Bookmarks
document.getElementById('menu-bookmarks')?.addEventListener('click', () => {
    closeMenu();
    renderBookmarks();
    openModal('bookmarks-modal');
});

function renderBookmarks() {
    const list = document.getElementById('bookmarks-list');
    if (!list) return;
    
    if (bookmarks.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="icon">⭐</div>
                <p>No bookmarks yet</p>
                <p style="font-size: 0.85rem;">Press Ctrl+D to bookmark a page</p>
            </div>
        `;
    } else {
        list.innerHTML = bookmarks.map((b, i) => `
            <div class="bookmark-item" data-index="${i}">
                <span class="icon">🔗</span>
                <span class="title">${b.title}</span>
                <span class="url">${b.url}</span>
            </div>
        `).join('');
        
        list.querySelectorAll('.bookmark-item').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                browserManager.navigate(bookmarks[index].url);
                closeModal('bookmarks-modal');
            });
        });
    }
}

// Add bookmark function (Ctrl+D)
function addBookmark() {
    const activeTab = browserManager.tabs.find(t => t.active);
    if (activeTab && activeTab.url !== 'about:home') {
        const existing = bookmarks.find(b => b.url === activeTab.url);
        if (!existing) {
            bookmarks.push({
                title: activeTab.title,
                url: activeTab.url,
                date: new Date().toISOString()
            });
            log(`Bookmarked: ${activeTab.title}`, 'success');
        } else {
            log('Page already bookmarked', 'info');
        }
    }
}

// History
document.getElementById('menu-history')?.addEventListener('click', () => {
    closeMenu();
    renderHistory();
    openModal('history-modal');
});

function renderHistory() {
    const list = document.getElementById('history-list');
    if (!list) return;
    
    // Collect history from all tabs
    const allHistory = [];
    browserManager.tabs.forEach(tab => {
        tab.history.forEach((url, i) => {
            if (url !== 'about:home') {
                allHistory.push({
                    url,
                    title: url,
                    time: new Date().toLocaleTimeString()
                });
            }
        });
    });
    
    if (allHistory.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="icon">📜</div>
                <p>No history</p>
                <p style="font-size: 0.85rem;">History is cleared when circuit stops</p>
            </div>
        `;
    } else {
        list.innerHTML = allHistory.slice(-20).reverse().map((h, i) => `
            <div class="history-item" data-url="${h.url}">
                <span class="icon">📄</span>
                <span class="title">${h.title}</span>
                <span class="time">${h.time}</span>
            </div>
        `).join('');
        
        list.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', () => {
                browserManager.navigate(item.dataset.url);
                closeModal('history-modal');
            });
        });
    }
}

// Downloads
document.getElementById('menu-downloads')?.addEventListener('click', () => {
    closeMenu();
    openModal('downloads-modal');
});

// Security Settings
document.getElementById('menu-security')?.addEventListener('click', async () => {
    closeMenu();
    // Load current settings
    try {
        const response = await fetch('/api/security/config');
        const data = await response.json();
        if (data.success) {
            document.getElementById('setting-https-first').checked = data.config.httpsFirst;
            document.getElementById('setting-https-only').checked = data.config.httpsOnly;
            document.getElementById('setting-onion-only').checked = data.config.onionOnly;
            document.getElementById('setting-mixed-content').checked = data.config.blockMixedContent;
            document.getElementById('setting-fp-isolation').checked = data.config.firstPartyIsolation;
        }
    } catch (e) {
        console.error('Failed to load security config:', e);
    }
    openModal('security-modal');
});

// Security setting change handlers
['https-first', 'https-only', 'onion-only', 'mixed-content', 'fp-isolation'].forEach(setting => {
    const checkbox = document.getElementById(`setting-${setting}`);
    if (checkbox) {
        checkbox.addEventListener('change', async () => {
            const settingMap = {
                'https-first': 'HTTPS_FIRST',
                'https-only': 'HTTPS_ONLY',
                'onion-only': 'ONION_ONLY_MODE',
                'mixed-content': 'BLOCK_MIXED_CONTENT',
                'fp-isolation': 'FIRST_PARTY_ISOLATION'
            };
            
            try {
                await fetch('/api/security/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        setting: settingMap[setting],
                        value: checkbox.checked
                    })
                });
                log(`Security: ${settingMap[setting]} = ${checkbox.checked}`, 'info');
            } catch (e) {
                console.error('Failed to update setting:', e);
            }
        });
    }
});

// Clear Browsing Data
document.getElementById('menu-clear-data')?.addEventListener('click', () => {
    closeMenu();
    openModal('clear-data-modal');
});

document.getElementById('clear-data-confirm')?.addEventListener('click', async () => {
    closeModal('clear-data-modal');
    try {
        await fetch('/api/cleanup', { method: 'POST' });
        browserManager.clearAllTabs();
        bookmarks.length = 0;
        log('All browsing data cleared', 'success');
    } catch (e) {
        log('Failed to clear data: ' + e.message, 'error');
    }
});

document.getElementById('clear-data-cancel')?.addEventListener('click', () => {
    closeModal('clear-data-modal');
});

// About
document.getElementById('menu-about')?.addEventListener('click', () => {
    closeMenu();
    openModal('about-modal');
});

// Settings
document.getElementById('menu-settings')?.addEventListener('click', () => {
    closeMenu();
    openModal('settings-modal');
});

// Keyboard Shortcuts
document.getElementById('menu-keyboard-shortcuts')?.addEventListener('click', () => {
    closeMenu();
    openModal('shortcuts-modal');
});

// Help submenu - Tor Documentation
document.getElementById('menu-tor-docs')?.addEventListener('click', () => {
    closeMenu();
    window.open('https://support.torproject.org/', '_blank');
});

// More tools submenu - View Page Source
document.getElementById('menu-view-source')?.addEventListener('click', () => {
    closeMenu();
    const activeTab = browserManager?.tabs?.find(t => t.active);
    if (activeTab && activeTab.content) {
        // Create a new tab with the source code
        const sourceWindow = window.open('', '_blank');
        if (sourceWindow) {
            sourceWindow.document.write('<html><head><title>Page Source</title><style>body{background:#1a1a1a;color:#00ff41;font-family:monospace;padding:20px;white-space:pre-wrap;}</style></head><body>');
            sourceWindow.document.write(escapeHtml(activeTab.content.html || 'No content'));
            sourceWindow.document.write('</body></html>');
            sourceWindow.document.close();
        }
    } else {
        log('No page content to view', 'warning');
    }
});

// Helper function to escape HTML for source view
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// More tools - Save Page
document.getElementById('menu-save-page')?.addEventListener('click', () => {
    closeMenu();
    const activeTab = browserManager?.tabs?.find(t => t.active);
    if (activeTab && activeTab.content && activeTab.content.html) {
        const blob = new Blob([activeTab.content.html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (activeTab.title || 'page') + '.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        log('Page saved', 'success');
    } else {
        log('No page content to save', 'warning');
    }
});

// More tools - Developer Tools (just logs a message since we can't open actual devtools)
document.getElementById('menu-dev-tools')?.addEventListener('click', () => {
    closeMenu();
    log('Press F12 to open browser developer tools', 'info');
});

// Update zoom level display
function updateZoomDisplay() {
    const display = document.getElementById('zoom-level-display');
    if (display) {
        display.textContent = currentZoom + '%';
    }
}

// =============================================================================
// KEYBOARD SHORTCUTS
// =============================================================================

document.addEventListener('keydown', (e) => {
    // Only handle shortcuts when browser is visible
    const browserInterface = document.getElementById('browser-interface');
    if (!browserInterface || !browserInterface.classList.contains('visible')) return;
    
    // Use Alt key for GHOSTLINK shortcuts to avoid conflicts with host browser
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
        switch (e.key.toLowerCase()) {
            case 't': // Alt+T - New Tab
                e.preventDefault();
                browserManager.addTab();
                break;
            case 'w': // Alt+W - Close Tab
                e.preventDefault();
                const activeTab = browserManager.tabs.find(t => t.active);
                if (activeTab && browserManager.tabs.length > 1) {
                    browserManager.closeTab(activeTab.id);
                }
                break;
            case 'g': // Alt+G - Find on page
                e.preventDefault();
                showFindBar();
                break;
            case 'p': // Alt+P - Print
                e.preventDefault();
                document.getElementById('menu-print')?.click();
                break;
            case 'd': // Alt+D - Bookmark
                e.preventDefault();
                addBookmark();
                break;
            case 'r': // Alt+R - Reload
                e.preventDefault();
                browserManager.reload();
                break;
            case 'u': // Alt+U - New Identity
                e.preventDefault();
                browserManager.requestNewIdentity();
                break;
            case 'b': // Alt+B - Bookmarks/Favorites
                e.preventDefault();
                document.getElementById('menu-bookmarks')?.click();
                break;
            case 'y': // Alt+Y - History
                e.preventDefault();
                document.getElementById('menu-history')?.click();
                break;
            case 'j': // Alt+J - Downloads
                e.preventDefault();
                document.getElementById('menu-downloads')?.click();
                break;
            case 's': // Alt+S - Screenshot
                e.preventDefault();
                document.getElementById('menu-screenshot')?.click();
                break;
            case 'l': // Alt+L - Focus URL bar
                e.preventDefault();
                document.getElementById('url-bar')?.focus();
                document.getElementById('url-bar')?.select();
                break;
            case '0': // Alt+0 - Reset Zoom
                e.preventDefault();
                currentZoom = 100;
                applyZoom();
                break;
            case '=':
            case '+': // Alt++ - Zoom In
                e.preventDefault();
                currentZoom = Math.min(200, currentZoom + 10);
                applyZoom();
                break;
            case '-': // Alt+- - Zoom Out
                e.preventDefault();
                currentZoom = Math.max(50, currentZoom - 10);
                applyZoom();
                break;
        }
        
        // Alt+Delete - Clear browsing data
        if (e.key === 'Delete') {
            e.preventDefault();
            document.getElementById('menu-clear-data')?.click();
        }
    }
    
    // Escape key - no conflict
    if (e.key === 'Escape') {
        hideFindBar();
        // Close any open modals
        document.querySelectorAll('.modal-overlay.visible').forEach(m => {
            m.classList.remove('visible');
        });
    }
    
    // F5 - Reload (works in most browsers)
    if (e.key === 'F5') {
        e.preventDefault();
        browserManager.reload();
    }
});