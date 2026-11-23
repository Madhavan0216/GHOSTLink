# PROJECT_CORE

## 1. Project Summary
GHOSTLINK is a Node.js privacy browser gateway that starts a local Express server, boots a bundled Tor daemon, and exposes a Tor-routed browsing UI in the browser. The application combines a terminal-style launcher, a circuit visualization, and a browser-like front end that proxies page loads, resources, and identity changes through Tor.

The repository also includes standalone support pieces for a custom relay demo and a WireGuard VPN server helper, but the primary runtime path is the Tor-backed browser on `http://localhost:3000` with the local proxy on `http://localhost:3001`.

## 2. Core Architecture

| File / Area | Responsibility |
|---|---|
| `server.js` | Main Express application. Serves `public/`, starts Tor automatically, exposes all HTTP APIs, manages browsing state, and coordinates cleanup/shutdown. |
| `db.js` | Persistence layer for settings and saved servers. Uses `better-sqlite3` when available and falls back to JSON storage if the native addon cannot load. |
| `tor_installer.js` | Downloads, extracts, and configures the Tor Expert Bundle, then writes a generated `torrc`. Also handles platform-specific install paths and executable permissions. |
| `tor_process.js` | Spawns Tor as a child process, parses bootstrap output, tracks readiness, supports restart attempts, and handles graceful stop/restart. |
| `tor_controller.js` | Talks to Tor's control port, authenticates with the cookie file, subscribes to events, requests NEWNYM, and fetches circuit/bootstrap details. |
| `tor_proxy.js` | HTTP/Tor proxy layer. Validates URLs, enforces Tor Browser-like header normalization, isolates circuits by first-party domain or tab, sanitizes HTML, rewrites resources, and verifies Tor connectivity. |
| `vpn_controller.js` | Generates local client keys and WireGuard config files for the demo VPN-related flow. |
| `relay_server.js` | Standalone custom relay example that forwards traffic using a simple binary protocol on port 9050. Not wired into the main UI flow. |
| `remote_server/vpn_server_node.js` | Linux-only WireGuard VPS helper that configures `wg0`, NAT, and peer addition. Deployment-only, not used by the main browser app. |
| `public/index.html` | Main UI shell: circuit panel, terminal log, browser chrome, modals, and shortcut/menu structure. |
| `public/app.js` | Front-end controller. Handles connect/disconnect animations, browser tab state, navigation, history, bookmarks, search, video helpers, settings, and keyboard shortcuts. |
| `public/style.css` | Primary visual system for the cyber-themed launcher and browser UI. |
| `public/temp_style.css` | Alternate/legacy browser styling snapshot. It is present in the repo but not linked by the current `index.html`. |
| `config/client_keys.json` | Generated client key pair written by `vpn_controller.js` and reused by the `/api/setup` flow. |
| `tor/` | Bundled Tor runtime, generated `torrc`, GeoIP data, control cookie, and cached Tor state. |
| `start.bat`, `stop.bat`, `install.bat` | Windows launch, shutdown, and dependency bootstrap helpers. |
| `TOR_INTEGRATION.md`, `REQUIREMENTS_CHECKLIST.md`, `remote_server/README.md`, `GHOSTLINK - Comprehensive Proj.txt` | Project documentation and operational notes. |

## 3. Tech Stack

### Runtime and Frameworks
- Node.js runtime.
- Express 5 for the HTTP server and API layer.
- CORS middleware for browser access.
- Tor Expert Bundle for anonymized routing and control-port integration.

### Direct npm Dependencies
- `better-sqlite3` for fast local persistence.
- `cors` for cross-origin headers.
- `express` for routes, static hosting, and middleware.
- `socks` for the custom relay demo dependency.
- `socks-proxy-agent` for Tor SOCKS proxy agent creation.

### Node Built-ins Used
- `fs`, `path`, `net`, `http`, `https`, `url`, `zlib`, `crypto`, `child_process`, `events`, `os`, `dgram`.

### Browser APIs and Front-End Primitives
- DOM APIs (`document`, event listeners, classList, templates, iframe sandboxing).
- Fetch API.
- Fullscreen API.
- `postMessage` for iframe navigation and form events.
- `Blob` and `URL.createObjectURL` for local page saves.
- `window.print`, clipboard-related checks, and native browser navigation/history primitives.

### Platform and Operational Tools
- Windows batch scripting (`.bat`) for start/stop/install flows.
- PowerShell for local process and port validation.
- Tor control port and SOCKS5 port.
- WireGuard tooling (`wg`, `wg-quick`, `iptables`) in the remote server helper.
- `tar` and archive extraction utilities for Tor bundle installation.

## 4. Key Features

- Automatic Tor bootstrap on server start, including bundle installation if Tor is missing.
- Control-port authentication using Tor's cookie file.
- Bootstrap progress monitoring with fallback behavior if startup stalls.
- Auto-restart logic for Tor crashes, capped by a retry limit.
- Tor Browser-style proxying with HTTPS-first behavior, mixed-content controls, and strict URL validation.
- First-party isolation for circuits using eTLD+1 grouping, plus tab-level isolation fallback.
- HTML sanitization and resource rewriting so page assets load through the local proxy.
- New identity support that clears session state and requests `NEWNYM`.
- Security configuration endpoint for runtime toggles such as HTTPS-only, onion-only, and mixed-content blocking.
- Local browser UI with tabs, address bar, search, history, bookmarks, downloads modal, zoom, find-in-page, and fullscreen controls.
- Video site detection and privacy embed helpers for YouTube, Piped, Invidious, Vimeo, and Dailymotion.
- Circuit visualization and animated connect/disconnect flows in the front end.
- Local persistence for settings and saved servers through SQLite, with JSON fallback if the native addon fails to load.
- WireGuard key/config generation helper for the separate VPN-oriented demo flow.
- Standalone relay and remote VPN scripts for alternate networking experiments.

## 5. How It Works

1. The server starts with `npm start` or `start.bat`, loads `server.js`, initializes persistence, serves `public/`, and kicks off Tor startup in the background.
2. `tor_process.js` checks for a local Tor binary, uses `tor_installer.js` to download/extract it when needed, writes a fresh `torrc`, and launches Tor as a child process.
3. `tor_controller.js` waits for the control port, authenticates with the cookie file, subscribes to status/circuit events, and exposes bootstrap/version/circuit queries.
4. `tor_proxy.js` listens on port 3001, validates outbound URLs, normalizes headers, isolates requests, rewrites HTML/CSS/resource URLs, and returns sanitized page content through Tor.
5. The browser UI in `public/index.html` and `public/app.js` lets the user click Build Circuit, which calls `/api/setup` and `/api/connect_onion` to establish or verify the Tor session.
6. When the UI loads a page, it routes through `/api/tor/page` or `/api/tor/fetch`, and the proxy injects interception logic to reroute links, forms, `fetch`, and `XMLHttpRequest` traffic back through the local APIs.
7. Security settings are fetched from `/api/security/config` and pushed back with POST requests; new identity uses `/api/tor/new-identity` and clears both proxy session state and UI caches.
8. Disconnect and cleanup flows call `/api/disconnect` or `/api/cleanup`, clear browsing state, optionally request a new Tor identity, and reset the front-end tabs and caches.
9. On shutdown, the server disconnects the Tor controller, stops the proxy, and terminates the Tor process cleanly.

## 6. Current Status

### Working
- The main app launches, serves the UI, and auto-starts Tor.
- The Tor SOCKS and control ports are configured and bootstrapped automatically.
- The proxy path works for HTML pages and non-HTML resources, including sanitization and rewriting.
- The front-end connect/disconnect flow, tab UI, navigation, fullscreen, zoom, history, bookmarks, and settings panels are implemented.
- Tor verification, status reporting, and new identity requests are implemented.
- The database layer now has a fallback path that prevents startup from failing if the native SQLite addon is mismatched.

### Incomplete
- The browser UI is feature-rich, but several menu items are lightweight implementations rather than full browser subsystems.
- Bookmarks, history, and downloads are mostly in-memory UI features; they are not a full browser profile system.
- `public/temp_style.css` appears to be a legacy/alternate stylesheet and is not part of the current HTML entrypoint.
- The standalone relay and remote WireGuard server are separate utilities, not part of the main route from the UI.

### Broken or Risky
- `package.json` has no real test suite; `npm test` is a placeholder.
- The code depends on live Tor availability and external verification endpoints such as torproject.org, so network restrictions can affect runtime behavior.
- Some documentation files describe older or simplified flows, so they should be treated as guidance rather than source of truth.
- The custom relay and remote VPN scripts are not integrated into the main browser experience, so they can be confusing if treated as part of the primary app.

## 7. Unique / Interesting Parts

- Tor Browser parity is not superficial here: the proxy normalizes headers, blocks speculative connections, enforces first-party isolation, upgrades HTTP when appropriate, and strips risky HTML features.
- The proxy injects a runtime script into served pages that intercepts `fetch`, `XMLHttpRequest`, link clicks, and form submissions so navigation continues through the local Tor-aware endpoints.
- `tor_process.js` parses Tor stdout to detect bootstrap progress and readiness, which gives the UI a live view of startup instead of a blind spinner.
- The app supports a safe fallback mode: if Tor cannot be installed or started, the UI still loads and the system degrades gracefully instead of crashing immediately.
- The local persistence layer now tolerates a native addon mismatch by falling back to JSON storage, which keeps startup resilient on machines with newer Node runtimes.
- The browser UI uses animated circuit buildup/teardown sequences to make the Tor session state visible to the user.
- The front end includes privacy-focused extras such as video-platform detection and privacy embed suggestions rather than blindly loading third-party pages.

## 8. Entry Point

### Primary Run Command
```bash
npm install
npm start
```

### Windows Helpers
```bash
start.bat
stop.bat
install.bat
```

### Direct Runtime Targets
- Backend/UI: `http://localhost:3000`
- Local Tor proxy: `http://localhost:3001`
- Tor SOCKS port: `127.0.0.1:9050`
- Tor control port: `127.0.0.1:9051`

### Notes
- On first run, Tor is auto-downloaded and installed into `./tor/` if missing.
- If you want to stop everything manually, use `stop.bat` or terminate the Node/Tor processes.