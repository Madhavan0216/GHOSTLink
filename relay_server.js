const net = require('net');
const { SocksClient } = require('socks');

// A simple SOCKS5 Relay Server (The "Node")
// In a real Tor-like network, this would handle layered encryption.
// Here, we implement a simple hop: Receive Data -> Forward to Next Hop.

const RELAY_PORT = 9050;

const server = net.createServer((socket) => {
    socket.once('data', (data) => {
        // Simple protocol: [TargetIPLength][TargetIP][TargetPort][Data]
        // This is a custom "Ghost" protocol, not standard SOCKS to avoid detection

        try {
            const ipLen = data.readUInt8(0);
            const targetIp = data.toString('utf8', 1, 1 + ipLen);
            const targetPort = data.readUInt16BE(1 + ipLen);
            const payload = data.slice(1 + ipLen + 2);

            console.log(`[Relay] Request to forward to ${targetIp}:${targetPort}`);

            const outbound = net.createConnection(targetPort, targetIp, () => {
                outbound.write(payload);
                socket.pipe(outbound);
                outbound.pipe(socket);
            });

            outbound.on('error', (err) => {
                console.error('[Relay] Outbound Error:', err.message);
                socket.end();
            });

        } catch (e) {
            console.error('[Relay] Malformed packet');
            socket.end();
        }
    });
});

server.listen(RELAY_PORT, () => {
    console.log(`GhostRelay Node running on port ${RELAY_PORT}`);
});
