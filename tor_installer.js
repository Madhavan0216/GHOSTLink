/**
 * GHOSTLINK Tor Installer
 * Automatically downloads and installs official Tor Expert Bundle
 * 
 * Supports: Windows, Linux, macOS
 * Source: Official Tor Project binaries only
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const crypto = require('crypto');
const os = require('os');

// Tor download configuration
const TOR_VERSION = '13.0.9';
const TOR_EXPERT_BUNDLE_VERSION = '13.0.9';

// Official Tor Project download URLs
const TOR_DOWNLOADS = {
    win32: {
        url: `https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/tor-expert-bundle-windows-x86_64-${TOR_EXPERT_BUNDLE_VERSION}.tar.gz`,
        fallbackUrl: `https://dist.torproject.org/torbrowser/${TOR_VERSION}/tor-expert-bundle-windows-x86_64-${TOR_EXPERT_BUNDLE_VERSION}.tar.gz`,
        filename: `tor-expert-bundle-windows-x86_64-${TOR_EXPERT_BUNDLE_VERSION}.tar.gz`,
        executable: 'tor/tor.exe'
    },
    linux: {
        url: `https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/tor-expert-bundle-linux-x86_64-${TOR_EXPERT_BUNDLE_VERSION}.tar.gz`,
        fallbackUrl: `https://dist.torproject.org/torbrowser/${TOR_VERSION}/tor-expert-bundle-linux-x86_64-${TOR_EXPERT_BUNDLE_VERSION}.tar.gz`,
        filename: `tor-expert-bundle-linux-x86_64-${TOR_EXPERT_BUNDLE_VERSION}.tar.gz`,
        executable: 'tor/tor'
    },
    darwin: {
        url: `https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/tor-expert-bundle-macos-x86_64-${TOR_EXPERT_BUNDLE_VERSION}.tar.gz`,
        fallbackUrl: `https://dist.torproject.org/torbrowser/${TOR_VERSION}/tor-expert-bundle-macos-x86_64-${TOR_EXPERT_BUNDLE_VERSION}.tar.gz`,
        filename: `tor-expert-bundle-macos-x86_64-${TOR_EXPERT_BUNDLE_VERSION}.tar.gz`,
        executable: 'tor/tor'
    }
};

// Simpler standalone Tor binaries as fallback
const TOR_STANDALONE = {
    win32: {
        // Windows standalone Tor from expert bundle
        url: 'https://www.torproject.org/dist/torbrowser/13.0.9/tor-expert-bundle-windows-x86_64-13.0.9.tar.gz',
        filename: 'tor-expert-bundle.tar.gz',
        executable: 'tor/tor.exe'
    }
};

class TorInstaller {
    constructor(options = {}) {
        this.baseDir = options.baseDir || path.join(__dirname, 'tor');
        this.binDir = path.join(this.baseDir, 'bin');
        this.dataDir = path.join(this.baseDir, 'data');
        this.downloadDir = path.join(this.baseDir, 'downloads');
        this.platform = os.platform();
        this.arch = os.arch();
        
        this.onProgress = options.onProgress || (() => {});
        this.onStatus = options.onStatus || ((msg) => console.log(`[TorInstaller] ${msg}`));
    }

    /**
     * Get platform-specific Tor configuration
     */
    getPlatformConfig() {
        const platform = this.platform === 'win32' ? 'win32' : 
                        this.platform === 'darwin' ? 'darwin' : 'linux';
        return TOR_DOWNLOADS[platform] || TOR_DOWNLOADS.linux;
    }

    /**
     * Check if Tor is already installed locally
     */
    isInstalled() {
        const config = this.getPlatformConfig();
        const torPath = path.join(this.binDir, config.executable);
        return fs.existsSync(torPath);
    }

    /**
     * Get path to Tor executable
     */
    getTorPath() {
        const config = this.getPlatformConfig();
        return path.join(this.binDir, config.executable);
    }

    /**
     * Get path to data directory
     */
    getDataDir() {
        return this.dataDir;
    }

    /**
     * Ensure all required directories exist
     */
    ensureDirectories() {
        const dirs = [this.baseDir, this.binDir, this.dataDir, this.downloadDir];
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }

    /**
     * Download file with progress tracking
     */
    async downloadFile(url, destPath, retries = 3) {
        return new Promise((resolve, reject) => {
            this.onStatus(`Downloading from ${url}`);
            
            const makeRequest = (currentUrl, redirectCount = 0) => {
                if (redirectCount > 5) {
                    reject(new Error('Too many redirects'));
                    return;
                }

                const protocol = currentUrl.startsWith('https') ? https : http;
                
                const request = protocol.get(currentUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:102.0) Gecko/20100101 Firefox/102.0'
                    },
                    timeout: 30000
                }, (response) => {
                    // Handle redirects
                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                        makeRequest(response.headers.location, redirectCount + 1);
                        return;
                    }

                    if (response.statusCode !== 200) {
                        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                        return;
                    }

                    const totalSize = parseInt(response.headers['content-length'], 10) || 0;
                    let downloadedSize = 0;

                    const file = fs.createWriteStream(destPath);
                    
                    response.on('data', (chunk) => {
                        downloadedSize += chunk.length;
                        if (totalSize > 0) {
                            const progress = Math.round((downloadedSize / totalSize) * 100);
                            this.onProgress(progress, downloadedSize, totalSize);
                        }
                    });

                    response.pipe(file);

                    file.on('finish', () => {
                        file.close();
                        resolve(destPath);
                    });

                    file.on('error', (err) => {
                        fs.unlink(destPath, () => {});
                        reject(err);
                    });
                });

                request.on('error', (err) => {
                    if (retries > 0) {
                        this.onStatus(`Download failed, retrying... (${retries} attempts left)`);
                        setTimeout(() => {
                            this.downloadFile(url, destPath, retries - 1)
                                .then(resolve)
                                .catch(reject);
                        }, 2000);
                    } else {
                        reject(err);
                    }
                });

                request.on('timeout', () => {
                    request.destroy();
                    reject(new Error('Download timeout'));
                });
            };

            makeRequest(url);
        });
    }

    /**
     * Extract tar.gz archive
     */
    async extractArchive(archivePath, destDir) {
        this.onStatus('Extracting Tor bundle...');

        // Use tar command (available on Windows 10+, Linux, macOS)
        return new Promise((resolve, reject) => {
            const command = this.platform === 'win32'
                ? `tar -xzf "${archivePath}" -C "${destDir}"`
                : `tar -xzf "${archivePath}" -C "${destDir}"`;

            exec(command, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    // Try alternative extraction methods
                    this.onStatus('Standard extraction failed, trying alternative method...');
                    this.extractWithNodeModules(archivePath, destDir)
                        .then(resolve)
                        .catch(reject);
                } else {
                    resolve(destDir);
                }
            });
        });
    }

    /**
     * Alternative extraction using built-in zlib
     */
    async extractWithNodeModules(archivePath, destDir) {
        const zlib = require('zlib');
        
        return new Promise((resolve, reject) => {
            // For simple extraction, we'll use a basic approach
            // In production, you'd want to use a proper tar library
            try {
                const gunzip = zlib.createGunzip();
                const input = fs.createReadStream(archivePath);
                const tempTar = archivePath.replace('.gz', '');
                const output = fs.createWriteStream(tempTar);

                input.pipe(gunzip).pipe(output);

                output.on('finish', () => {
                    // Now extract the tar
                    exec(`tar -xf "${tempTar}" -C "${destDir}"`, (error) => {
                        fs.unlink(tempTar, () => {}); // Cleanup
                        if (error) {
                            reject(error);
                        } else {
                            resolve(destDir);
                        }
                    });
                });

                output.on('error', reject);
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Set executable permissions (Linux/macOS)
     */
    setExecutablePermissions() {
        if (this.platform === 'win32') return;

        const config = this.getPlatformConfig();
        const torPath = path.join(this.binDir, config.executable);
        
        try {
            fs.chmodSync(torPath, 0o755);
            
            // Also set permissions for other binaries in the tor directory
            const torDir = path.dirname(torPath);
            if (fs.existsSync(torDir)) {
                const files = fs.readdirSync(torDir);
                for (const file of files) {
                    const filePath = path.join(torDir, file);
                    if (!fs.statSync(filePath).isDirectory()) {
                        fs.chmodSync(filePath, 0o755);
                    }
                }
            }
        } catch (err) {
            this.onStatus(`Warning: Could not set executable permissions: ${err.message}`);
        }
    }

    /**
     * Generate default torrc configuration
     */
    generateTorrc(options = {}) {
        const socksPort = options.socksPort || 9050;
        const controlPort = options.controlPort || 9051;
        
        // Use absolute paths to avoid Tor warnings
        const absoluteDataDir = path.resolve(this.dataDir).replace(/\\/g, '/');
        const absoluteCookieFile = path.resolve(path.join(this.dataDir, 'control_auth_cookie')).replace(/\\/g, '/');
        const geoipPath = path.resolve(path.join(this.binDir, 'data', 'geoip')).replace(/\\/g, '/');
        const geoip6Path = path.resolve(path.join(this.binDir, 'data', 'geoip6')).replace(/\\/g, '/');
        
        const torrc = `
# GHOSTLINK Auto-generated Tor Configuration
# Do not edit - regenerated on each start

# Network Settings
SocksPort ${socksPort}
ControlPort ${controlPort}

# Authentication
CookieAuthentication 1
CookieAuthFile ${absoluteCookieFile}

# Data Directory (absolute path)
DataDirectory ${absoluteDataDir}

# GeoIP files
GeoIPFile ${geoipPath}
GeoIPv6File ${geoip6Path}

# Performance & Privacy
AvoidDiskWrites 1
SafeLogging 1
Log notice stdout

# Circuit Settings
CircuitBuildTimeout 30
LearnCircuitBuildTimeout 0
MaxCircuitDirtiness 600

# Connection Settings
ConnectionPadding auto
ReducedConnectionPadding 0
`.trim();

        const torrcPath = path.join(this.dataDir, 'torrc');
        fs.writeFileSync(torrcPath, torrc);
        
        return torrcPath;
    }

    /**
     * Main installation method
     */
    async install() {
        this.onStatus('Starting Tor installation...');
        this.ensureDirectories();

        if (this.isInstalled()) {
            this.onStatus('Tor is already installed');
            return { success: true, path: this.getTorPath(), alreadyInstalled: true };
        }

        const config = this.getPlatformConfig();
        const archivePath = path.join(this.downloadDir, config.filename);

        try {
            // Try primary URL first
            try {
                await this.downloadFile(config.url, archivePath);
            } catch (primaryErr) {
                this.onStatus(`Primary download failed: ${primaryErr.message}`);
                this.onStatus('Trying fallback URL...');
                await this.downloadFile(config.fallbackUrl, archivePath);
            }

            // Extract archive
            await this.extractArchive(archivePath, this.binDir);

            // Set permissions
            this.setExecutablePermissions();

            // Cleanup download
            try {
                fs.unlinkSync(archivePath);
            } catch (e) {
                // Ignore cleanup errors
            }

            // Verify installation
            if (!this.isInstalled()) {
                throw new Error('Installation verification failed - Tor binary not found');
            }

            this.onStatus('Tor installation complete');
            return { success: true, path: this.getTorPath() };

        } catch (err) {
            this.onStatus(`Installation failed: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    /**
     * Check for updates (compares versions)
     */
    async checkForUpdates() {
        // In a production system, you'd check torproject.org for latest version
        // For now, we just return the current version info
        return {
            currentVersion: TOR_VERSION,
            updateAvailable: false
        };
    }

    /**
     * Uninstall Tor (cleanup)
     */
    async uninstall() {
        try {
            if (fs.existsSync(this.baseDir)) {
                fs.rmSync(this.baseDir, { recursive: true, force: true });
            }
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
}

// Singleton instance
let installerInstance = null;

function getTorInstaller(options) {
    if (!installerInstance) {
        installerInstance = new TorInstaller(options);
    }
    return installerInstance;
}

module.exports = { TorInstaller, getTorInstaller };
