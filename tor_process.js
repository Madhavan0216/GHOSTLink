/**
 * GHOSTLINK Tor Process Manager
 * Manages Tor daemon lifecycle as a child process
 * 
 * Features:
 * - Automatic startup with bootstrap monitoring
 * - Crash recovery with auto-restart
 * - Graceful shutdown handling
 * - Silent failover to simulated mode
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { getTorInstaller } = require('./tor_installer');

class TorProcess extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.installer = getTorInstaller(options);
        this.process = null;
        this.isRunning = false;
        this.isBootstrapped = false;
        this.bootstrapProgress = 0;
        this.lastBootstrapMessage = '';
        this.restartAttempts = 0;
        this.maxRestartAttempts = options.maxRestartAttempts || 3;
        this.restartDelay = options.restartDelay || 5000;
        this.startupTimeout = options.startupTimeout || 120000; // 2 minutes
        
        // Ports
        this.socksPort = options.socksPort || 9050;
        this.controlPort = options.controlPort || 9051;
        
        // State
        this.startPromise = null;
        this.shutdownRequested = false;
        this.startupTimer = null;
        
        // Output buffers
        this.stdoutBuffer = '';
        this.stderrBuffer = '';
        
        // Debug mode
        this.debug = options.debug || false;
        
        // Setup graceful shutdown handlers
        this._setupShutdownHandlers();
    }

    /**
     * Setup process exit handlers for graceful shutdown
     */
    _setupShutdownHandlers() {
        const shutdown = () => {
            if (!this.shutdownRequested) {
                this.shutdownRequested = true;
                this.stop().catch(() => {});
            }
        };

        process.on('exit', shutdown);
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        // Don't shutdown on uncaught exceptions from network errors
        // process.on('uncaughtException', ...) removed to prevent premature shutdown
    }

    /**
     * Log message (debug mode only to console, always to event)
     */
    _log(message, level = 'info') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [TorProcess] ${message}`;
        
        if (this.debug) {
            console.log(logMessage);
        }
        
        this.emit('log', { level, message, timestamp });
    }

    /**
     * Parse Tor bootstrap progress from output
     */
    _parseBootstrapProgress(line) {
        // Match Tor's actual output format:
        // Dec 23 12:50:35.986 [notice] Bootstrapped 5% (conn_done): Connected to guard...
        // Or: Bootstrapped 50% (loading_descriptors): Loading relay descriptors
        const match = line.match(/Bootstrapped\s+(\d+)%\s*(?:\([^)]*\))?[:\s]*(.*)$/i);
        if (match) {
            const progress = parseInt(match[1], 10);
            const message = match[2]?.trim() || '';
            
            if (progress !== this.bootstrapProgress || progress === 100) {
                this.bootstrapProgress = progress;
                this.lastBootstrapMessage = message;
                this.emit('bootstrap', { progress, message });
                this._log(`Bootstrap: ${progress}% - ${message}`);
                
                if (progress === 100 && !this.isBootstrapped) {
                    this.isBootstrapped = true;
                    this.emit('ready');
                    this._log('Tor is fully bootstrapped and ready');
                    
                    // Clear startup timeout
                    if (this.startupTimer) {
                        clearTimeout(this.startupTimer);
                        this.startupTimer = null;
                    }
                }
            }
        }
    }

    /**
     * Handle Tor process stdout
     */
    _handleStdout(data) {
        const text = data.toString();
        this.stdoutBuffer += text;
        
        // Process line by line
        const lines = this.stdoutBuffer.split('\n');
        this.stdoutBuffer = lines.pop() || '';
        
        for (const line of lines) {
            if (line.trim()) {
                // Log all Tor output in debug mode
                this._log(`Tor: ${line}`);
                
                // Parse bootstrap progress
                this._parseBootstrapProgress(line);
                
                // Check for circuit established
                if (line.toLowerCase().includes('circuit established')) {
                    this.emit('circuit_ready');
                }
                
                // Check for opening SOCKS listener (means Tor is ready to accept connections)
                if (line.includes('Opening Socks listener')) {
                    this._log('Tor SOCKS listener opened');
                }
                
                // Check for Control port ready
                if (line.includes('Opening Control listener')) {
                    this._log('Tor Control port opened');
                }
            }
        }
    }

    /**
     * Handle Tor process stderr
     */
    _handleStderr(data) {
        const text = data.toString();
        this.stderrBuffer += text;
        
        const lines = this.stderrBuffer.split('\n');
        this.stderrBuffer = lines.pop() || '';
        
        for (const line of lines) {
            if (line.trim()) {
                this._log(`Tor stderr: ${line}`, 'error');
            }
        }
    }

    /**
     * Handle Tor process exit
     */
    async _handleExit(code, signal) {
        this.isRunning = false;
        this.isBootstrapped = false;
        this.process = null;
        
        this._log(`Tor process exited with code ${code}, signal ${signal}`);
        this.emit('exit', { code, signal });

        // Clear startup timer
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }

        // Auto-restart if not intentionally stopped
        if (!this.shutdownRequested && this.restartAttempts < this.maxRestartAttempts) {
            this.restartAttempts++;
            this._log(`Attempting restart (${this.restartAttempts}/${this.maxRestartAttempts})...`);
            
            setTimeout(() => {
                this.start().catch(err => {
                    this._log(`Restart failed: ${err.message}`, 'error');
                });
            }, this.restartDelay);
        } else if (!this.shutdownRequested) {
            this._log('Max restart attempts reached, entering simulated mode', 'error');
            this.emit('failed');
        }
    }

    /**
     * Install Tor if not present
     */
    async ensureInstalled() {
        if (!this.installer.isInstalled()) {
            this._log('Tor not found, installing...');
            this.emit('installing');
            
            const result = await this.installer.install();
            
            if (!result.success) {
                throw new Error(`Failed to install Tor: ${result.error}`);
            }
            
            this.emit('installed');
        }
        
        return this.installer.getTorPath();
    }

    /**
     * Start Tor process
     */
    async start() {
        // Prevent multiple simultaneous starts
        if (this.startPromise) {
            return this.startPromise;
        }

        this.startPromise = this._doStart();
        
        try {
            const result = await this.startPromise;
            return result;
        } finally {
            this.startPromise = null;
        }
    }

    /**
     * Internal start implementation
     */
    async _doStart() {
        if (this.isRunning) {
            this._log('Tor is already running');
            return { success: true, alreadyRunning: true };
        }

        this.shutdownRequested = false;
        this.bootstrapProgress = 0;
        this.isBootstrapped = false;

        try {
            // Ensure Tor is installed
            const torPath = await this.ensureInstalled();
            this._log(`Using Tor binary: ${torPath}`);

            // Generate torrc
            const torrcPath = this.installer.generateTorrc({
                socksPort: this.socksPort,
                controlPort: this.controlPort
            });
            this._log(`Generated torrc: ${torrcPath}`);

            // Start Tor process
            return new Promise((resolve, reject) => {
                const args = ['-f', torrcPath];
                
                this._log(`Starting Tor with args: ${args.join(' ')}`);
                
                this.process = spawn(torPath, args, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    detached: false,
                    windowsHide: true
                });

                this.isRunning = true;
                this.emit('starting');

                // Handle stdout
                this.process.stdout.on('data', (data) => {
                    this._handleStdout(data);
                });

                // Handle stderr
                this.process.stderr.on('data', (data) => {
                    this._handleStderr(data);
                });

                // Handle process exit
                this.process.on('exit', (code, signal) => {
                    this._handleExit(code, signal);
                });

                // Handle process error
                this.process.on('error', (err) => {
                    this._log(`Tor process error: ${err.message}`, 'error');
                    this.isRunning = false;
                    reject(err);
                });

                // Wait for bootstrap or timeout
                const onReady = () => {
                    this.removeListener('failed', onFailed);
                    clearTimeout(this.startupTimer);
                    this.restartAttempts = 0; // Reset on successful start
                    resolve({ success: true, bootstrapped: true });
                };

                const onFailed = () => {
                    this.removeListener('ready', onReady);
                    clearTimeout(this.startupTimer);
                    reject(new Error('Tor failed to start'));
                };

                this.once('ready', onReady);
                this.once('failed', onFailed);

                // Startup timeout
                this.startupTimer = setTimeout(() => {
                    this.removeListener('ready', onReady);
                    this.removeListener('failed', onFailed);
                    
                    if (this.bootstrapProgress > 0) {
                        // Partial bootstrap, consider it a success
                        this._log(`Startup timeout reached at ${this.bootstrapProgress}% bootstrap`);
                        resolve({ 
                            success: true, 
                            bootstrapped: this.isBootstrapped,
                            progress: this.bootstrapProgress 
                        });
                    } else {
                        reject(new Error('Tor startup timeout'));
                    }
                }, this.startupTimeout);
            });

        } catch (err) {
            this._log(`Failed to start Tor: ${err.message}`, 'error');
            return { success: false, error: err.message };
        }
    }

    /**
     * Start Tor process without waiting for bootstrap (non-blocking)
     * Returns immediately after process starts
     */
    async startBackground() {
        if (this.isRunning) {
            this._log('Tor is already running');
            return { success: true, alreadyRunning: true };
        }

        this.shutdownRequested = false;
        this.bootstrapProgress = 0;
        this.isBootstrapped = false;

        try {
            // Ensure Tor is installed
            const torPath = await this.ensureInstalled();
            this._log(`Using Tor binary: ${torPath}`);

            // Generate torrc
            const torrcPath = this.installer.generateTorrc({
                socksPort: this.socksPort,
                controlPort: this.controlPort
            });
            this._log(`Generated torrc: ${torrcPath}`);

            const args = ['-f', torrcPath];
            this._log(`Starting Tor with args: ${args.join(' ')}`);
            
            this.process = spawn(torPath, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false,
                windowsHide: true
            });

            this.isRunning = true;
            this.emit('starting');

            // Handle stdout
            this.process.stdout.on('data', (data) => {
                this._handleStdout(data);
            });

            // Handle stderr
            this.process.stderr.on('data', (data) => {
                this._handleStderr(data);
            });

            // Handle process exit
            this.process.on('exit', (code, signal) => {
                this._handleExit(code, signal);
            });

            // Handle process error
            this.process.on('error', (err) => {
                this._log(`Tor process error: ${err.message}`, 'error');
                this.isRunning = false;
                this.emit('error', err);
            });

            return { success: true, pid: this.process.pid };

        } catch (err) {
            this._log(`Failed to start Tor: ${err.message}`, 'error');
            return { success: false, error: err.message };
        }
    }

    /**
     * Stop Tor process gracefully
     */
    async stop() {
        this.shutdownRequested = true;
        
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }

        if (!this.process || !this.isRunning) {
            return { success: true };
        }

        return new Promise((resolve) => {
            this._log('Stopping Tor process...');

            const forceKillTimer = setTimeout(() => {
                if (this.process) {
                    this._log('Force killing Tor process');
                    this.process.kill('SIGKILL');
                }
            }, 5000);

            this.process.once('exit', () => {
                clearTimeout(forceKillTimer);
                this._log('Tor process stopped');
                resolve({ success: true });
            });

            // Send SIGTERM for graceful shutdown
            this.process.kill('SIGTERM');
        });
    }

    /**
     * Restart Tor process
     */
    async restart() {
        this._log('Restarting Tor...');
        await this.stop();
        
        // Wait a bit before restarting
        await new Promise(r => setTimeout(r, 1000));
        
        return this.start();
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            running: this.isRunning,
            bootstrapped: this.isBootstrapped,
            bootstrapProgress: this.bootstrapProgress,
            lastBootstrapMessage: this.lastBootstrapMessage,
            pid: this.process?.pid || null,
            socksPort: this.socksPort,
            controlPort: this.controlPort,
            restartAttempts: this.restartAttempts
        };
    }

    /**
     * Wait for Tor to be ready (bootstrapped)
     */
    async waitForReady(timeout = 60000) {
        if (this.isBootstrapped) {
            return { success: true };
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeListener('ready', onReady);
                this.removeListener('failed', onFailed);
                
                if (this.bootstrapProgress >= 50) {
                    // Partial success
                    resolve({ success: true, partial: true, progress: this.bootstrapProgress });
                } else {
                    reject(new Error('Timeout waiting for Tor'));
                }
            }, timeout);

            const onReady = () => {
                clearTimeout(timer);
                this.removeListener('failed', onFailed);
                resolve({ success: true });
            };

            const onFailed = () => {
                clearTimeout(timer);
                this.removeListener('ready', onReady);
                reject(new Error('Tor failed'));
            };

            this.once('ready', onReady);
            this.once('failed', onFailed);
        });
    }

    /**
     * Get path to control auth cookie
     */
    getCookiePath() {
        return path.join(this.installer.getDataDir(), 'control_auth_cookie');
    }
}

// Singleton instance
let torProcessInstance = null;

function getTorProcess(options) {
    if (!torProcessInstance) {
        torProcessInstance = new TorProcess(options);
    }
    return torProcessInstance;
}

module.exports = { TorProcess, getTorProcess };
