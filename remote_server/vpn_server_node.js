const dgram = require('dgram');
const fs = require('fs');
const { exec } = require('child_process');

// This is a simplified Node.js wrapper for managing a WireGuard Interface on Linux
// It assumes 'wireguard-tools' is installed on the server (apt install wireguard)

const WG_INTERFACE = 'wg0';
const SERVER_PORT = 51820;
const PRIVATE_KEY_PATH = '/etc/wireguard/private.key';
const PUBLIC_KEY_PATH = '/etc/wireguard/public.key';

function setupServer() {
    console.log('Initializing GhostLink VPN Server Node...');

    // 1. Check for keys
    if (!fs.existsSync(PRIVATE_KEY_PATH)) {
        console.log('Generating Server Keys...');
        exec('wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key', (err) => {
            if (err) {
                console.error('Error generating keys. Ensure WireGuard is installed.', err);
                return;
            }
            configureInterface();
        });
    } else {
        configureInterface();
    }
}

function configureInterface() {
    console.log('Configuring Interface...');
    const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8').trim();

    const config = `
[Interface]
Address = 10.0.0.1/24
SaveConfig = true
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE
ListenPort = ${SERVER_PORT}
PrivateKey = ${privateKey}
    `;

    fs.writeFileSync(`/etc/wireguard/${WG_INTERFACE}.conf`, config);
    console.log(`Configuration written to /etc/wireguard/${WG_INTERFACE}.conf`);

    startInterface();
}

function startInterface() {
    exec(`wg-quick up ${WG_INTERFACE}`, (err, stdout, stderr) => {
        if (err) {
            // It might already be up
            console.log('Interface might already be up or error occurred:', stderr);
        } else {
            console.log('VPN Interface UP successfully!');
        }

        console.log(`Server is ready. Public IP: (Check your VPS IP)`);
        console.log(`Port: ${SERVER_PORT}`);
        console.log(`Public Key: ${fs.readFileSync(PUBLIC_KEY_PATH, 'utf8').trim()}`);
    });
}

// Simple API to add a peer (Client)
// In a real scenario, this would be an Express server protected by auth
function addPeer(clientPublicKey, clientIp) {
    const cmd = `wg set ${WG_INTERFACE} peer ${clientPublicKey} allowed-ips ${clientIp}/32`;
    exec(cmd, (err) => {
        if (err) console.error('Failed to add peer:', err);
        else console.log(`Peer added: ${clientPublicKey} (${clientIp})`);
    });
}

setupServer();

// Keep alive
setInterval(() => { }, 10000);
