/**
 * GHOSTLINK Tor Controller
 * Handles communication with the Tor daemon via Control Port
 * 
 * Features:
 * - Automatic connection to local bundled Tor
 * - Cookie-based authentication
 * - Circuit management and monitoring
 * - NEWNYM signal support
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

class TorController extends EventEmitter {
    constructor(options = {}) {
        super();
        this.controlHost = options.controlHost || '127.0.0.1';
        this.controlPort = options.controlPort || 9051;
        this.socksHost = options.socksHost || '127.0.0.1';
        this.socksPort = options.socksPort || 9050;
        this.password = options.password || '';
        
        // Local Tor data directory (bundled Tor)
        this.localDataDir = options.localDataDir || path.join(__dirname, 'tor', 'data');
        this.cookiePath = options.cookiePath || this._findCookiePath();
        
        this.socket = null;
        this.connected = false;
        this.authenticated = false;
        this.bootstrapProgress = 0;
        this.circuits = new Map();
        this.currentExitIP = null;
        this.responseBuffer = '';
        this.pendingCallbacks = [];
        
        // Connection retry settings
        this.maxRetries = options.maxRetries || 30;
        this.retryDelay = options.retryDelay || 1000;
    }

    /**
     * Find Tor cookie file path based on OS
     * Prioritizes local bundled Tor cookie
     */
    _findCookiePath() {
        const possiblePaths = [
            // Local bundled Tor (HIGHEST PRIORITY)
            path.join(__dirname, 'tor', 'data', 'control_auth_cookie'),
            // Linux system Tor
            '/var/run/tor/control.authcookie',
            '/var/lib/tor/control_auth_cookie',
            path.join(process.env.HOME || '', '.tor', 'control_auth_cookie'),
            // Windows system Tor
            path.join(process.env.APPDATA || '', 'tor', 'control_auth_cookie'),
            path.join(process.env.LOCALAPPDATA || '', 'Tor Browser', 'Browser', 'TorBrowser', 'Data', 'Tor', 'control_auth_cookie'),
            // macOS
            '/usr/local/var/lib/tor/control_auth_cookie',
            path.join(process.env.HOME || '', 'Library', 'Application Support', 'TorBrowser-Data', 'Tor', 'control_auth_cookie')
        ];

        for (const p of possiblePaths) {
            try {
                if (fs.existsSync(p)) {
                    return p;
                }
            } catch (e) {
                // Continue searching
            }
        }
        return null;
    }
    
    /**
     * Update cookie path (called after Tor starts)
     */
    updateCookiePath(cookiePath) {
        if (cookiePath && fs.existsSync(cookiePath)) {
            this.cookiePath = cookiePath;
        } else {
            // Re-scan for cookie
            this.cookiePath = this._findCookiePath();
        }
    }

    /**
     * Connect to Tor control port with retries
     */
    async connect(retries = null) {
        retries = retries ?? this.maxRetries;
        
        return new Promise((resolve, reject) => {
            if (this.connected) {
                resolve(true);
                return;
            }

            this.socket = new net.Socket();
            let connectionResolved = false;
            
            const cleanup = () => {
                if (this.socket) {
                    this.socket.removeAllListeners();
                }
            };
            
            this.socket.connect(this.controlPort, this.controlHost, () => {
                if (connectionResolved) return;
                connectionResolved = true;
                this.connected = true;
                this.emit('connected');
                resolve(true);
            });

            this.socket.on('data', (data) => {
                this._handleData(data.toString());
            });

            this.socket.on('error', async (err) => {
                if (connectionResolved) return;
                cleanup();
                
                this.connected = false;
                this.authenticated = false;
                
                // Retry connection if attempts remaining
                if (retries > 0) {
                    await new Promise(r => setTimeout(r, this.retryDelay));
                    try {
                        const result = await this.connect(retries - 1);
                        connectionResolved = true;
                        resolve(result);
                    } catch (retryErr) {
                        connectionResolved = true;
                        reject(retryErr);
                    }
                } else {
                    connectionResolved = true;
                    this.emit('error', err);
                    reject(err);
                }
            });

            this.socket.on('close', () => {
                this.connected = false;
                this.authenticated = false;
                this.emit('disconnected');
            });

            // Timeout for this connection attempt
            setTimeout(() => {
                if (!connectionResolved && !this.connected) {
                    connectionResolved = true;
                    if (this.socket) {
                        this.socket.destroy();
                    }
                    reject(new Error('Connection timeout'));
                }
            }, 5000);
        });
    }
    
    /**
     * Connect with wait - waits for Tor to be available
     */
    async connectWithWait(maxWaitMs = 60000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWaitMs) {
            try {
                await this.connect(0); // Single attempt
                return true;
            } catch (err) {
                // Wait before retry
                await new Promise(r => setTimeout(r, 1000));
                // Refresh cookie path in case Tor just created it
                this.cookiePath = this._findCookiePath();
            }
        }
        
        throw new Error('Timeout waiting for Tor control port');
    }

    /**
     * Handle incoming data from control port
     */
    _handleData(data) {
        this.responseBuffer += data;
        
        // Process complete responses (end with \r\n)
        const lines = this.responseBuffer.split('\r\n');
        this.responseBuffer = lines.pop() || '';

        for (const line of lines) {
            if (line.length === 0) continue;

            // Check for async events (650 code)
            if (line.startsWith('650')) {
                this._handleAsyncEvent(line);
                continue;
            }

            // Handle response to pending command
            if (this.pendingCallbacks.length > 0) {
                const callback = this.pendingCallbacks.shift();
                const code = parseInt(line.substring(0, 3));
                const message = line.substring(4);
                callback({ code, message, raw: line });
            }
        }
    }

    /**
     * Handle asynchronous events from Tor
     */
    _handleAsyncEvent(line) {
        const eventData = line.substring(4);
        
        if (eventData.startsWith('STATUS_CLIENT')) {
            this._parseStatusEvent(eventData);
        } else if (eventData.startsWith('CIRC')) {
            this._parseCircuitEvent(eventData);
        } else if (eventData.startsWith('STREAM')) {
            this._parseStreamEvent(eventData);
        }
    }

    /**
     * Parse bootstrap status events
     */
    _parseStatusEvent(data) {
        const bootstrapMatch = data.match(/BOOTSTRAP PROGRESS=(\d+)/);
        if (bootstrapMatch) {
            this.bootstrapProgress = parseInt(bootstrapMatch[1]);
            this.emit('bootstrap', this.bootstrapProgress);
        }

        if (data.includes('CIRCUIT_ESTABLISHED')) {
            this.emit('circuit_established');
        }
    }

    /**
     * Parse circuit events
     */
    _parseCircuitEvent(data) {
        const parts = data.split(' ');
        const circuitId = parts[1];
        const status = parts[2];

        this.circuits.set(circuitId, { status, raw: data });
        this.emit('circuit', { id: circuitId, status, data });
    }

    /**
     * Parse stream events
     */
    _parseStreamEvent(data) {
        this.emit('stream', data);
    }

    /**
     * Send command to Tor control port
     */
    async sendCommand(command) {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                reject(new Error('Not connected to Tor control port'));
                return;
            }

            let resolved = false;
            const wrappedResolve = (response) => {
                if (!resolved) {
                    resolved = true;
                    resolve(response);
                }
            };

            this.pendingCallbacks.push(wrappedResolve);
            this.socket.write(command + '\r\n');

            // Timeout for response
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    // Remove the callback from pending queue
                    const index = this.pendingCallbacks.indexOf(wrappedResolve);
                    if (index > -1) {
                        this.pendingCallbacks.splice(index, 1);
                    }
                    reject(new Error(`Command timeout: ${command}`));
                }
            }, 10000);
        });
    }

    /**
     * Authenticate with Tor control port
     */
    async authenticate() {
        if (this.authenticated) return true;

        try {
            // Try cookie authentication first
            if (this.cookiePath && fs.existsSync(this.cookiePath)) {
                const cookie = fs.readFileSync(this.cookiePath);
                const cookieHex = cookie.toString('hex');
                const response = await this.sendCommand(`AUTHENTICATE ${cookieHex}`);
                if (response.code === 250) {
                    this.authenticated = true;
                    this.emit('authenticated');
                    return true;
                }
            }

            // Try password authentication
            if (this.password) {
                const response = await this.sendCommand(`AUTHENTICATE "${this.password}"`);
                if (response.code === 250) {
                    this.authenticated = true;
                    this.emit('authenticated');
                    return true;
                }
            }

            // Try null authentication (if allowed)
            const response = await this.sendCommand('AUTHENTICATE');
            if (response.code === 250) {
                this.authenticated = true;
                this.emit('authenticated');
                return true;
            }

            throw new Error('Authentication failed');
        } catch (err) {
            this.emit('auth_error', err);
            throw err;
        }
    }

    /**
     * Subscribe to Tor events
     */
    async subscribeEvents(events = ['STATUS_CLIENT', 'CIRC', 'STREAM']) {
        const response = await this.sendCommand(`SETEVENTS ${events.join(' ')}`);
        return response.code === 250;
    }

    /**
     * Get current bootstrap status
     */
    async getBootstrapStatus() {
        const response = await this.sendCommand('GETINFO status/bootstrap-phase');
        if (response.code === 250) {
            const match = response.message.match(/PROGRESS=(\d+)/);
            if (match) {
                this.bootstrapProgress = parseInt(match[1]);
                return this.bootstrapProgress;
            }
        }
        return 0;
    }

    /**
     * Check if Tor is fully bootstrapped
     */
    async isBootstrapped() {
        const progress = await this.getBootstrapStatus();
        return progress === 100;
    }

    /**
     * Request new identity (NEWNYM signal)
     * This clears caches and builds new circuits
     */
    async newIdentity() {
        const response = await this.sendCommand('SIGNAL NEWNYM');
        if (response.code === 250) {
            this.emit('new_identity');
            return true;
        }
        return false;
    }

    /**
     * Get circuit information
     */
    async getCircuitInfo() {
        const response = await this.sendCommand('GETINFO circuit-status');
        if (response.code === 250) {
            return this._parseCircuitInfo(response.message);
        }
        return [];
    }

    /**
     * Parse circuit info response
     */
    _parseCircuitInfo(data) {
        const circuits = [];
        const lines = data.split('\n');
        
        for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split(' ');
            if (parts.length >= 3) {
                circuits.push({
                    id: parts[0],
                    status: parts[1],
                    path: parts.slice(2).join(' ')
                });
            }
        }
        return circuits;
    }

    /**
     * Get current exit node IP
     */
    async getExitIP() {
        try {
            const response = await this.sendCommand('GETINFO address');
            if (response.code === 250) {
                this.currentExitIP = response.message.split('=')[1];
                return this.currentExitIP;
            }
        } catch (e) {
            // Fallback - will be checked via external service
        }
        return null;
    }

    /**
     * Get Tor version
     */
    async getVersion() {
        const response = await this.sendCommand('GETINFO version');
        if (response.code === 250) {
            return response.message.split('=')[1];
        }
        return null;
    }

    /**
     * Check if Tor daemon is running and accessible
     */
    async checkTorStatus() {
        try {
            await this.connect();
            await this.authenticate();
            const bootstrapped = await this.isBootstrapped();
            const version = await this.getVersion();
            
            return {
                running: true,
                authenticated: this.authenticated,
                bootstrapped,
                bootstrapProgress: this.bootstrapProgress,
                version,
                socksPort: this.socksPort,
                controlPort: this.controlPort
            };
        } catch (err) {
            return {
                running: false,
                error: err.message,
                socksPort: this.socksPort,
                controlPort: this.controlPort
            };
        }
    }

    /**
     * Check if connected to Tor control port
     */
    isConnected() {
        return this.connected && this.socket !== null;
    }

    /**
     * Close connection
     */
    disconnect() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
        this.authenticated = false;
    }
}

// Singleton instance
let torController = null;

function getTorController(options) {
    if (!torController) {
        torController = new TorController(options);
    }
    return torController;
}

module.exports = { TorController, getTorController };
