# GHOSTLINK - Requirements Checklist

## ✅ System Requirements

### Node.js & NPM
- [x] **Node.js**: v18.0.0 or higher (Current: v22.21.0) ✅
- [x] **NPM**: v8.0.0 or higher (Current: v10.9.4) ✅

### Operating System
- [x] Windows 10+ (with tar command for Tor bundle extraction)
- [ ] OR Linux (Ubuntu/Debian/Fedora)
- [ ] OR macOS 10.15+

### Network
- [x] Internet connection for Tor bundle download (first run)
- [x] Ports 3000, 3001, 9050, 9051 available

## ✅ NPM Dependencies

All dependencies are installed:

| Package | Required Version | Status |
|---------|------------------|--------|
| better-sqlite3 | ^12.5.0 | ✅ Installed |
| cors | ^2.8.5 | ✅ Installed |
| express | ^5.2.1 | ✅ Installed |
| socks | ^2.8.7 | ✅ Installed |
| socks-proxy-agent | ^8.0.5 | ✅ Installed |

## ✅ Project Structure

Required files and directories:
- [x] `server.js` - Main application server
- [x] `db.js` - SQLite database handler
- [x] `tor_controller.js` - Tor control port communication
- [x] `tor_process.js` - Tor daemon lifecycle management
- [x] `tor_proxy.js` - HTTP proxy through Tor
- [x] `tor_installer.js` - Auto-download Tor bundle
- [x] `vpn_controller.js` - Key generation utilities
- [x] `public/` - Frontend files (index.html, app.js, style.css)
- [x] `config/` - Configuration storage
- [x] `tor/` - Tor binaries and data (auto-created on first run)

## ⚠️ First Run Notes

1. **Tor Installation**: On first run, GHOSTLINK will automatically download and install the Tor Expert Bundle (~20MB)
2. **Database Creation**: SQLite database (`vpn_data.db`) will be created automatically
3. **Firewall**: You may need to allow Node.js through your firewall

## 🚀 Running the Application

```bash
# Navigate to project directory
cd "c:\Users\madha\Downloads\NewProJ"

# Install dependencies (if needed)
npm install

# Start the server
npm start
```

## 📍 Access Points

- **Web Interface**: http://localhost:3000
- **Tor Proxy**: http://localhost:3001
- **Tor SOCKS**: localhost:9050 (when running)
- **Tor Control**: localhost:9051 (when running)
