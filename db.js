const fs = require('fs');
const path = require('path');

let Database = null;
try {
    Database = require('better-sqlite3');
} catch (err) {
    Database = null;
}

const dbPath = path.join(__dirname, 'vpn_data.db');
const fallbackPath = path.join(__dirname, 'vpn_data.json');
let db = null;
let fallbackData = { settings: [], servers: [], nextServerId: 1 };

function loadFallbackData() {
    try {
        if (fs.existsSync(fallbackPath)) {
            const raw = fs.readFileSync(fallbackPath, 'utf8');
            const parsed = JSON.parse(raw);
            fallbackData = {
                settings: Array.isArray(parsed.settings) ? parsed.settings : [],
                servers: Array.isArray(parsed.servers) ? parsed.servers : [],
                nextServerId: Number.isInteger(parsed.nextServerId) ? parsed.nextServerId : 1
            };
        }
    } catch (err) {
        fallbackData = { settings: [], servers: [], nextServerId: 1 };
    }
}

function saveFallbackData() {
    fs.writeFileSync(fallbackPath, JSON.stringify(fallbackData, null, 2));
}

function ensureDatabase() {
    if (db || !Database) {
        return db;
    }

    db = new Database(dbPath);
    return db;
}

function initDb() {
    if (!Database) {
        loadFallbackData();
        saveFallbackData();
        return;
    }

    const database = ensureDatabase();

    database.exec(`CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        key_name TEXT,
        value TEXT
    )`);

    database.exec(`CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        endpoint TEXT,
        public_key TEXT,
        allowed_ips TEXT,
        is_active INTEGER DEFAULT 0
    )`);
}

function saveServer(name, endpoint, publicKey, allowedIps) {
    return new Promise((resolve, reject) => {
        try {
            if (!Database) {
                const id = fallbackData.nextServerId++;
                fallbackData.servers.push({ id, name, endpoint, public_key: publicKey, allowed_ips: allowedIps, is_active: 0 });
                saveFallbackData();
                resolve(id);
                return;
            }

            const stmt = ensureDatabase().prepare(`INSERT INTO servers (name, endpoint, public_key, allowed_ips) VALUES (?, ?, ?, ?)`);
            const info = stmt.run(name, endpoint, publicKey, allowedIps);
            resolve(info.lastInsertRowid);
        } catch (err) {
            reject(err);
        }
    });
}

function getServers() {
    return new Promise((resolve, reject) => {
        try {
            if (!Database) {
                resolve(fallbackData.servers.map((server) => ({
                    id: server.id,
                    name: server.name,
                    endpoint: server.endpoint,
                    public_key: server.public_key,
                    allowed_ips: server.allowed_ips,
                    is_active: server.is_active || 0
                })));
                return;
            }

            const stmt = ensureDatabase().prepare("SELECT * FROM servers");
            const rows = stmt.all();
            resolve(rows);
        } catch (err) {
            reject(err);
        }
    });
}

function saveSetting(key, value) {
    return new Promise((resolve, reject) => {
        try {
            if (!Database) {
                const existingIndex = fallbackData.settings.findIndex((row) => row.key_name === key);
                const entry = { id: existingIndex >= 0 ? fallbackData.settings[existingIndex].id : fallbackData.settings.length + 1, key_name: key, value };

                if (existingIndex >= 0) {
                    fallbackData.settings[existingIndex] = entry;
                } else {
                    fallbackData.settings.push(entry);
                }

                saveFallbackData();
                resolve();
                return;
            }

            const stmt = ensureDatabase().prepare(`INSERT OR REPLACE INTO settings (id, key_name, value) VALUES (
                (SELECT id FROM settings WHERE key_name = ?),
                ?,
                ?
            )`);
            stmt.run(key, key, value);
            resolve();
        } catch (err) {
            reject(err);
        }
    });
}

function getSetting(key) {
    return new Promise((resolve, reject) => {
        try {
            if (!Database) {
                const row = fallbackData.settings.find((entry) => entry.key_name === key);
                resolve(row ? row.value : null);
                return;
            }

            const stmt = ensureDatabase().prepare("SELECT value FROM settings WHERE key_name = ?");
            const row = stmt.get(key);
            resolve(row ? row.value : null);
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { initDb, saveServer, getServers, saveSetting, getSetting };
