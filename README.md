# GHOSTLink

GHOSTLink is a Windows-first privacy browser prototype built with Node.js and a vanilla HTML/CSS/JavaScript frontend. It starts a local Express server, manages an official Tor Expert Bundle, exposes a Tor SOCKS/control setup, and provides an animated circuit and browser-style interface.

The primary application is available at `http://localhost:3000`. The local HTTP proxy listens on port `3001`; Tor uses SOCKS port `9050` and control port `9051`.

> GHOSTLink is an educational networking prototype. It does not independently guarantee anonymity, and users should not rely on it as a replacement for the Tor Browser or for sensitive, high-risk use.

## Features

- Automatic Tor bundle download and local startup
- Tor bootstrap progress and process lifecycle monitoring
- Tor control-port circuit information and NEWNYM identity requests
- Local proxy routing for HTTP and HTTPS traffic
- Circuit visualization and connect/disconnect controls
- Tabbed browser-style interface with history and bookmarks
- HTTPS-first, mixed-content blocking, onion-only, and isolation settings
- HTML/CSS/resource rewriting through the local proxy
- Privacy shortcuts for DuckDuckGo, Check IP, and ProtonMail
- SQLite persistence with a JSON fallback
- Windows install, start, and shutdown batch scripts
- Separate relay-server and WireGuard deployment experiments

## Screenshot Gallery

| Screenshot | What it shows |
|---|---|
| [Requirements installer](screenshots/requirements-installer.png) | Dependency and Tor environment check |
| [Startup console](screenshots/startup-console.png) | Windows launcher and server startup sequence |
| [Tor bootstrap logs](screenshots/tor-bootstrap-logs.png) | Tor process, control port, and bootstrap activity |
| [Launcher interface](screenshots/launcher-interface.png) | Main circuit-control screen |
| [Browser welcome](screenshots/browser-welcome.png) | GHOSTLink browser start page |
| [Proxy activity](screenshots/proxy-activity.png) | Requests passing through the local proxy |
| [Connected circuit](screenshots/connected-circuit.png) | Established anonymized circuit and exit IP |
| [Tor routing logs](screenshots/tor-routing-logs.png) | Live Tor routing and verification output |
| [Disconnect flow](screenshots/disconnect-flow.png) | Circuit teardown and browsing-data cleanup |
| [Shutdown sequence](screenshots/shutdown-sequence.png) | Application service shutdown |

## Architecture

```text
Browser UI
  -> Express API/static server (port 3000)
  -> Tor HTTP proxy (port 3001)
  -> Tor SOCKS5 client (port 9050)
  -> Tor control port (port 9051)
```

| Component | Responsibility |
|---|---|
| `server.js` | Express entry point, APIs, Tor startup, circuit state, and shutdown coordination |
| `tor_installer.js` | Downloads and extracts the Tor Expert Bundle |
| `tor_process.js` | Starts, restarts, monitors, and stops the Tor daemon |
| `tor_controller.js` | Authenticates with Tor and queries circuits, status, and NEWNYM |
| `tor_proxy.js` | Validates, rewrites, isolates, and forwards browser traffic |
| `db.js` | Settings and server persistence with SQLite/JSON fallback |
| `vpn_controller.js` | Generates demonstration WireGuard keys and configuration |
| `relay_server.js` | Standalone relay experiment |
| `remote_server/vpn_server_node.js` | Linux WireGuard server deployment helper |
| `public/index.html` | Browser launcher and interface markup |
| `public/app.js` | Tabs, navigation, settings, history, and circuit UI |
| `public/style.css` | Primary interface theme |

## Technology

- Node.js 18 or newer
- Express 5
- `better-sqlite3`
- CORS
- SOCKS and SOCKS Proxy Agent packages
- Vanilla JavaScript, HTML5, and CSS3
- Tor Expert Bundle
- Windows batch and PowerShell helpers

## Requirements

- Windows 10 or newer is recommended
- Node.js 18+ and npm
- Internet access for first-run Tor bundle download
- Available ports `3000`, `3001`, `9050`, and `9051`

For Linux or macOS experiments, Node.js dependencies can be installed directly. The included `.bat` helpers are Windows-specific.

## Installation

```powershell
cd C:\path\to\GHOSTLink
npm install
```

Windows users can also run:

```text
install.bat
```

To check dependencies and the Tor binary through the terminal:

```powershell
npm start
```

## Running

### npm

```powershell
npm start
```

Open `http://localhost:3000`.

### Windows scripts

```text
start.bat
stop.bat
install.bat
```

`start.bat` starts the server, opens the browser, and writes logs to `ghostlink.log`. `stop.bat` stops Node, Tor, and closes the local browser tabs.

## First Run

On the first run GHOSTLink:

1. Detects whether the Tor Expert Bundle exists.
2. Downloads and extracts it into `tor/` when missing.
3. Generates a local `torrc`.
4. Starts Tor and waits for bootstrap progress.
5. Opens the control and SOCKS ports.
6. Starts the local proxy and browser interface.

Generated runtime files are ignored by Git. Use the UI or server logs to verify that Tor has reached 100% bootstrap before relying on circuit-dependent behavior.

## API Overview

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/status` | Server, Tor, circuit, and exit status |
| `POST` | `/api/setup` | Generate or load client key material |
| `POST` | `/api/connect_onion` | Build or verify the active circuit |
| `POST` | `/api/disconnect` | Disconnect and clear browsing state |
| `GET` | `/api/tor/status` | Detailed Tor status |
| `POST` | `/api/tor/new-identity` | Request a new Tor identity |
| `GET` | `/api/tor/page?url=...&tabId=...` | Load a page through Tor |
| `POST` | `/api/security/config` | Change runtime proxy security settings |
| `GET` | `/api/security/config` | Read runtime proxy security settings |

Additional proxy, browser, database, and cleanup routes are implemented in `server.js`.

## Persistence

`db.js` uses `better-sqlite3` to create `vpn_data.db` and stores settings and server records. If the native database addon cannot load, GHOSTLink falls back to `vpn_data.json`.

Both generated database paths are ignored by Git. `config/client_keys.json` is also ignored because it may contain key material.

## Tor Verification

Inside GHOSTLink, use `Check IP` or open the Tor Project API manually:

```powershell
curl --socks5 127.0.0.1:9050 https://check.torproject.org/api/ip
```

The returned JSON should report `IsTor: true` for a functional Tor exit connection.

## Troubleshooting

### Tor does not start

- Confirm ports `9050` and `9051` are not in use.
- Check `tor/torrc` and generated Tor logs.
- Allow Node.js and Tor through the local firewall.
- Temporarily disable VPN or aggressive proxy settings.
- Remove only generated `tor/` data and restart if the installation is corrupted.

### Bootstrap remains stuck

- Check whether the network blocks Tor connections.
- Synchronize the system clock.
- Review ISP/firewall restrictions.
- Configure bridges in `tor/torrc` when needed.
- Check the Tor logs before changing exit-node settings.

### Better SQLite cannot load

GHOSTLink automatically uses JSON persistence. To restore SQLite, run:

```powershell
npm rebuild better-sqlite3
npm start
```

### Port already in use

Find the process and stop the conflicting service:

```powershell
netstat -ano | findstr ":3000"
netstat -ano | findstr ":3001"
netstat -ano | findstr ":9050"
netstat -ano | findstr ":9051"
```

## Security Notes

- Do not commit private keys, database files, logs, cookies, or generated Tor state.
- The Tor control port uses cookie authentication locally.
- Browser traffic is sanitized, but anonymity depends on Tor availability and correct proxy configuration.
- External scripts, ads, media, browser extensions, and downloaded files may weaken privacy controls.
- The standalone relay and WireGuard components are demonstrations and are not a complete audited VPN implementation.

## Project Status

GHOSTLink is a working local prototype. The browser UI and Tor integration are implemented, but features such as full download management, persistent profiles, and a complete audited security model remain incomplete. The repository includes no meaningful automated test suite at present.
