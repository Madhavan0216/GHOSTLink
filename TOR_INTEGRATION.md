# GHOSTLINK - Real Tor Browser Integration

## Overview

GHOSTLINK now features **automatic Tor integration**. When you start GHOSTLINK, it will automatically:

1. **Download** the official Tor Expert Bundle from torproject.org
2. **Install** Tor in the `./tor` directory
3. **Configure** Tor with optimal security settings
4. **Start** the Tor daemon as a managed child process
5. **Monitor** bootstrap progress and restart on failures

**No manual Tor installation required!**

## Quick Start

```bash
# Install dependencies
npm install

# Start GHOSTLINK (Tor will auto-install and start)
npm start
```

That's it! GHOSTLINK handles everything automatically.

## What Happens on First Run

1. GHOSTLINK detects Tor is not installed
2. Downloads Tor Expert Bundle (~30-50MB depending on OS)
3. Extracts to `./tor/bin/`
4. Generates optimized `torrc` configuration
5. Starts Tor daemon and monitors bootstrap
6. Connects to Control Port for circuit management
7. Ready for anonymous browsing!

## Architecture

```
GHOSTLINK
├── tor_installer.js   # Downloads & installs Tor Expert Bundle
├── tor_process.js     # Manages Tor daemon lifecycle
├── tor_controller.js  # Communicates with Tor via Control Port
├── tor_proxy.js       # Routes HTTP traffic through Tor SOCKS5
└── server.js          # Main Express backend
```

## Automatic Features

### Auto-Download & Install
- Detects OS (Windows/Linux/macOS)
- Downloads official Tor Expert Bundle from torproject.org
- Verifies integrity (checksum when available)
- Extracts to local `./tor` directory

### Auto-Configuration
Generated `torrc` includes:
```
SocksPort 9050
ControlPort 9051
CookieAuthentication 1
DataDirectory ./tor/data
GeoIPFile ./tor/data/geoip
GeoIPv6File ./tor/data/geoip6
ExitNodes {us},{de},{nl},{se},{ch}
StrictNodes 0
CircuitBuildTimeout 30
NumEntryGuards 3
SafeSocks 1
WarnUnsafeSocks 1
```

### Auto-Restart
- Monitors Tor process health
- Auto-restarts on crash (up to 3 attempts)
- Graceful shutdown on application exit

## Manual Configuration (Optional)

### Custom torrc
Edit `./tor/torrc` after first run to customize:

```
# Use specific exit countries
ExitNodes {us},{gb},{de}
StrictNodes 1

# Exclude certain countries
ExcludeNodes {ru},{cn},{ir}

# Bridge configuration (for censored networks)
UseBridges 1
Bridge obfs4 IP:PORT FINGERPRINT
```

### Environment Variables
```bash
# Custom ports
TOR_SOCKS_PORT=9050
TOR_CONTROL_PORT=9051

# Debug mode
TOR_DEBUG=true
```

## Verifying Tor Connection

### Via GHOSTLINK UI
1. Open http://localhost:3000
2. Click "Connect"
3. Check the circuit visualization
4. Your exit IP should show a Tor exit node

### Via Command Line
```bash
# Check if traffic goes through Tor
curl --socks5 127.0.0.1:9050 https://check.torproject.org/api/ip

# Should return: {"IsTor":true,"IP":"xxx.xxx.xxx.xxx"}
```

## API Endpoints

### GET /api/status
Returns current Tor connection status:
```json
{
  "success": true,
  "torRunning": true,
  "torConnected": true,
  "bootstrapProgress": 100,
  "circuit": [...],
  "exitIP": "185.220.101.xxx"
}
```

### GET /api/tor/status
Detailed Tor status:
```json
{
  "success": true,
  "connected": true,
  "running": true,
  "bootstrapped": true,
  "bootstrapProgress": 100,
  "version": "0.4.8.10"
}
```

### POST /api/connect_onion
Establishes Tor circuit:
```json
{
  "success": true,
  "circuit": [
    {"name": "Guard-Node", "role": "Entry"},
    {"name": "Middle-Node", "role": "Relay"},
    {"name": "Exit-Node", "role": "Exit"}
  ],
  "exitIP": "185.220.101.xxx",
  "isTor": true
}
```

### POST /api/tor/new-identity
Requests new Tor identity (new circuit):
```json
{
  "success": true,
  "message": "New identity requested",
  "circuit": [...]
}
```

### POST /api/proxy/fetch
Fetches URL through Tor:
```json
{
  "url": "https://example.com",
  "tabId": "tab_1"
}
```

## Troubleshooting

### Tor Won't Start
```bash
# Check logs
cat ./tor/logs/tor.log

# Verify permissions
ls -la ./tor/bin/

# On Windows, run as Administrator if needed
```

### Download Fails
- Check internet connection
- Try manual download from https://www.torproject.org/download/tor/
- Extract to `./tor/bin/`

### Bootstrap Stuck
```bash
# Common causes:
# 1. Firewall blocking ports
# 2. ISP blocking Tor
# 3. Clock sync issues

# Try bridges:
# Edit ./tor/torrc and add bridge configuration
```

### High CPU Usage
Normal during bootstrap. Should stabilize after reaching 100%.

## Security Notes

1. **Cookie Authentication**: Uses local cookie file for Control Port auth
2. **No Passwords in Config**: Cookie auth is more secure than password auth
3. **Exit Node Selection**: Configured to prefer privacy-friendly countries
4. **SafeSocks**: Enabled to prevent DNS leaks
5. **Automatic Updates**: Bundle version checked on each start

## Supported Platforms

| Platform | Architecture | Status |
|----------|-------------|--------|
| Windows  | x64         | ✅ Full Support |
| Linux    | x64         | ✅ Full Support |
| macOS    | x64         | ✅ Full Support |
| macOS    | ARM64       | ✅ Full Support |

## Fallback Mode

If Tor installation fails, GHOSTLINK operates in **Simulated Mode**:
- UI fully functional
- Simulated circuit visualization
- Real browsing without Tor anonymity
- Clear warning displayed to user

## Advanced: Manual Tor Installation

If automatic installation doesn't work, you can install Tor manually:

### Windows
```powershell
# Download Tor Expert Bundle
# Extract to ./tor/bin/
# Ensure tor.exe is at ./tor/bin/tor/tor.exe
```

### Linux
```bash
# Option 1: System Tor
sudo apt install tor
# GHOSTLINK will detect and use system Tor

# Option 2: Manual bundle
wget https://dist.torproject.org/tor-expert-bundle/...
tar -xzf tor-expert-bundle-*.tar.gz -C ./tor/bin/
```

### macOS
```bash
brew install tor
# GHOSTLINK will detect and use Homebrew Tor
````
4. Ensure Control Port is on 127.0.0.1:9051
```

### 3. Access GHOSTLINK

Open http://localhost:3000 in your browser.

## Features

### Real Tor Browsing
- All HTTP/HTTPS traffic is routed through Tor
- Full support for `.onion` hidden services
- DNS resolution through Tor (no DNS leaks)

### Circuit Management
- Build real Tor circuits with 3 hops
- Request new identity (NEWNYM) to get fresh circuits
- Circuit status monitoring

### Tab Isolation
- Each browser tab uses a unique Tor circuit (stream isolation)
- Cookies and session data are isolated per tab
- Prevents cross-tab tracking

### Security Features
- **Header Normalization**: User-Agent, Accept-Language standardized
- **Script Blocking**: JavaScript disabled in fetched content for safety
- **CSP Enforcement**: Content Security Policy headers added
- **XSS Protection**: HTML content is sanitized before display

## API Endpoints

### Tor Status
```
GET /api/tor/status
```
Returns Tor daemon status, bootstrap progress, version.

### Verify Tor Connection
```
GET /api/tor/check
```
Verifies traffic is actually going through Tor by checking with torproject.org.

### Fetch URL Through Tor
```
GET /api/tor/fetch?url=<URL>&tabId=<TAB_ID>
```
Fetches a URL through the Tor SOCKS5 proxy.

### New Identity
```
POST /api/tor/new-identity
```
Requests a new Tor identity (NEWNYM signal), clears circuits.

### Circuit Info
```
GET /api/tor/circuits
```
Returns information about current Tor circuits.

## Troubleshooting

### "Tor daemon not available"
- Ensure Tor is installed and running
- Check that SOCKS5 proxy is on port 9050 (or 9150 for Tor Browser)
- Update `tor_controller.js` if using non-standard ports

### "Connection timeout"
- Some .onion sites may be offline or slow
- Increase timeout in `tor_proxy.js` if needed
- Try verifying Tor connection first: `/api/tor/check`

### "Authentication failed"
- Ensure Control Port is enabled (port 9051)
- Check cookie authentication or password is configured
- On Linux, ensure your user has access to the cookie file

### Tor Browser Port Differences
Tor Browser uses different ports by default:
- SOCKS5: `9150` (instead of 9050)
- Control: `9151` (instead of 9051)

Update `server.js` if using Tor Browser:
```javascript
const torController = getTorController({
    controlPort: 9151,
    socksPort: 9150
});
```

## Security Considerations

1. **This is a research/educational tool** - Not a replacement for Tor Browser
2. **JavaScript is disabled** in rendered pages for safety
3. **WebRTC is blocked** in the browser context
4. **No browser fingerprinting protection** - Use real Tor Browser for sensitive activities
5. **Exit node trust** - Be aware that exit nodes can see unencrypted traffic

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   GHOSTLINK     │     │   Tor Proxy     │     │   Tor Daemon    │
│   Frontend      │────▶│   (Node.js)     │────▶│   (SOCKS5)      │
│   (Browser)     │     │   Port 3001     │     │   Port 9050     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                                ┌─────────────────┐
                                                │   Tor Network   │
                                                │ (3-hop circuit) │
                                                └─────────────────┘
                                                        │
                                                        ▼
                                                ┌─────────────────┐
                                                │   Destination   │
                                                │ (Website/.onion)│
                                                └─────────────────┘
```

## License

MIT License - For educational and research purposes only.
