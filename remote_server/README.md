# GhostLink VPN Server Deployment

To run your own VPN backend that bypasses firewalls, you need a VPS (Virtual Private Server).

## 1. Get a VPS
- Providers: DigitalOcean, AWS, Linode, Vultr.
- OS: Ubuntu 20.04 or 22.04 LTS.

## 2. Install WireGuard
Run these commands on your VPS:
```bash
sudo apt update
sudo apt install wireguard nodejs npm -y
```

## 3. Deploy the Server Script
Upload `vpn_server_node.js` to your VPS.

## 4. Run the Server
```bash
sudo node vpn_server_node.js
```

This script will:
1. Generate server keys.
2. Configure the `wg0` interface.
3. Set up IP forwarding (NAT) so you can access the internet.
4. Output the **Public Key** you need to enter in your Client App.

## 5. Add Your Client
To allow your client to connect, run this command on the server (replace with your client's Public Key from the app):
```bash
sudo wg set wg0 peer <CLIENT_PUBLIC_KEY> allowed-ips 10.0.0.2/32
```
