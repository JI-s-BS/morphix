# Using Morphix from anywhere

Morphix runs on a machine at home (or school, or a makerspace) and serves its website on port **8080** on that network. This guide
shows how to reach it from outside: on mobile data, at work, or on a friend's Wi-Fi.

> **Read this first.** Morphix controls a machine that heats to 250 °C and moves on its own. Anyone who reaches the page can try
> to sign in. Pick the safest option that works for you, use a long admin password, and keep Morphix updated (`morphix update`).

| Option | Difficulty | Opens your router? | Good for |
|---|---|---|---|
| [1. Tailscale (private VPN)](#1-tailscale-recommended) | ⭐ easiest | No | You and your family, on your own devices |
| [2. Cloudflare Tunnel](#2-cloudflare-tunnel) | ⭐⭐ | No | A real web address (`print.example.com`) with HTTPS |
| [3. Your own server (VPS) as a reverse proxy](#3-your-own-server-vps-reverse-proxy) | ⭐⭐⭐ | No | You already run a server and want everything on it |
| [4. Port forwarding on your router](#4-port-forwarding-last-resort) | ⭐⭐ | **Yes** | Only if nothing above works; read every step |

Whatever you choose, first check Morphix works at home: `morphix status` prints the local address, e.g. `http://192.168.1.20:8080`.

---

## 1. Tailscale (recommended)

Tailscale builds a private network between your devices. Nothing on the internet can see Morphix; only devices signed in to your Tailscale account can.

1. On the Morphix machine:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
   Open the link it prints and sign in.
2. Install the Tailscale app on your phone or laptop and sign in with the **same account**.
3. On the Morphix machine, `tailscale ip -4` shows its Tailscale address (`100.x.y.z`). Open `http://100.x.y.z:8080` from your phone.
   With MagicDNS on (the default), `http://<machine-name>:8080` works too.

**HTTPS and the microphone.** Browsers allow voice only on secure pages. Tailscale can give the machine a real certificate:

```bash
sudo tailscale serve --bg 8080      # https://<machine-name>.<your-tailnet>.ts.net → Morphix
```

Open the `https://….ts.net` address `tailscale serve status` prints. This stays private to your Tailscale devices. (Don't use
`tailscale funnel`: that publishes Morphix to the whole internet.)

To share with someone, invite them to your tailnet, or share just this machine (Tailscale admin console → Machines → Share).

Alternatives that work the same way: [ZeroTier](https://www.zerotier.com/), or WireGuard if you run your own VPN.

---

## 2. Cloudflare Tunnel

The tunnel makes an outgoing connection from the Morphix machine to Cloudflare, so your router stays closed. You get HTTPS on
your own domain. You need a free Cloudflare account and a domain whose DNS is on Cloudflare.

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (type *Cloudflared*). Name it `morphix`.
2. Follow the install command it shows for your system (Debian / Raspberry Pi OS: the `.deb` for `arm64` or `amd64`).
   It ends with `sudo cloudflared service install <token>`. Paste only the token Cloudflare gives you.
3. **Public hostname**: `print.example.com` → service `http://localhost:8080`.
4. **Protect it with Cloudflare Access** (strongly recommended): Zero Trust → Access → Applications → Add →
   *Self-hosted* → `print.example.com` → a policy "Emails: you@example.com". People must then prove their email to Cloudflare
   *before* they ever reach Morphix's own sign-in.
5. Morphix sees the visit come from `localhost`. Keep Morphix bound to localhost only, so nobody on your network can bypass Cloudflare:
   set `MORPHIX_BIND=127.0.0.1` in `/etc/morphix/morphix.env` (user install: `~/.config/morphix/morphix.env`), then `morphix restart`.
   (Open it at home through the tunnel address too.)

Server-Sent Events (live printer status) work through Cloudflare Tunnel without extra settings.

---

## 3. Your own server (VPS) reverse proxy

You have a server on the internet (a VPS from Hetzner, DigitalOcean, Linode, Oracle free tier …) and want `https://print.example.com`
to go through it to the Morphix machine at home. The safe way is a private link between the two (WireGuard or Tailscale), and the
VPS forwards web traffic over that link. Your home router stays closed.

1. **Link the two machines.** The easiest is Tailscale on both (section 1). Then the VPS reaches Morphix at `http://<morphix-machine>:8080`.
2. **On the VPS, install Caddy** (automatic HTTPS):
   ```bash
   sudo apt install -y caddy
   ```
   `/etc/caddy/Caddyfile`:
   ```caddy
   print.example.com {
       # Optional extra lock in front of Morphix's own sign-in (generate the hash with: caddy hash-password)
       # basic_auth { you $2a$14$...hash... }
       reverse_proxy <morphix-machine>:8080 {
           flush_interval -1          # live printer events (SSE) stream right away
       }
   }
   ```
   `sudo systemctl reload caddy`. Point `print.example.com`'s DNS **A record** at the VPS.
3. **Nginx instead of Caddy:**
   ```nginx
   server {
       listen 443 ssl http2;
       server_name print.example.com;
       # ssl_certificate … (certbot --nginx sets these up)
       client_max_body_size 150m;              # model uploads
       location / {
           proxy_pass http://<morphix-machine>:8080;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header Connection "";
           proxy_buffering off;                # live printer events (SSE)
           proxy_read_timeout 1h;
       }
   }
   ```

Morphix checks that requests that change something come from its own page (the `Origin` must match the `Host`), so keep
`proxy_set_header Host $host` (Caddy does this by default). The rate limit counts the proxy as one visitor; that's expected.

---

## 4. Port forwarding (last resort)

This opens a door from the whole internet straight to Morphix. Bots scan for open ports within minutes. Only do it if 1–3 are
impossible, and do **all** of these:

1. **Turn on HTTPS in Morphix first**, so passwords never cross the internet in plain text. In the data dir's `config.json`
   (`/var/lib/morphix/config.json` for the system service, `~/.local/share/morphix/config.json` for a user install), set
   `"https": true` inside `"server"`, then `morphix restart`. Morphix makes a self-signed certificate with `openssl`; browsers
   warn once. (Better: use option 2 or 3 for a real certificate.)
2. **Give the Morphix machine a fixed address** on your network: in the router, a *DHCP reservation* for its MAC address.
3. **Forward one port** in the router (often under *NAT*, *Port forwarding*, *Virtual server* or *Gaming*):
   - external port: something unusual, e.g. `48080` (not 8080 or 80);
   - internal IP: the Morphix machine; internal port: `8080`; protocol TCP.
   Never forward the printer itself (ports like 8899, 7125, 8883, 990, 80 on the printer).
4. Find your public address: `curl -4 https://ifconfig.me`. Open `https://<that-address>:48080`.
   Most home addresses change now and then; a free dynamic-DNS name (DuckDNS, No-IP, your router's own DDNS) keeps one name pointing home.
5. **Lock it down:** a long admin password (`morphix reset-admin` to set one), only the accounts you need, `morphix update` regularly,
   and look at `morphix logs` now and then for failed sign-ins. Morphix already limits sign-in attempts and requests per address.
6. **Close it again** when you no longer need it.

**CGNAT:** if your router's WAN address is `100.64.x.x`–`100.127.x.x`, or differs from what `ifconfig.me` shows, your internet provider
shares one public address between customers and port forwarding can't work. Use option 1, 2 or 3.

---

## Checking it works

- From your phone **on mobile data** (Wi-Fi off), open the address. You should see the Morphix sign-in.
- `curl -s https://print.example.com/api/health` shows `{"ok":true,…}` (it's public and shows no secrets).
- Live status updates on the Printer page mean the event stream gets through your tunnel or proxy.

## Morfix Cloud (preview)

Instead of opening anything, a Morphix machine can also **pair** with Morfix Cloud: Morphix shows a pairing code and QR code, you
enter the code or scan the QR on the cloud website, and that machine shows up in your cloud dashboard. Morphix only makes outgoing
connections for this. It's a private preview for now.
