# Running the Aura hub on company infrastructure

Work laptops block all incoming connections, so a phone can't reach Aura on the laptop.
The fix is to run the **hub** centrally. The laptop's **agent** only makes an *outbound*
WebSocket connection to it, so the laptop firewall stays exactly as IT set it.

```
Phone ──(zero-trust network / company SSO, HTTPS)──► Aura hub (container) ◄──(outbound WSS)── agent on laptop
```

## What the hub needs
| | |
|---|---|
| Image | `Dockerfile` in this repo (Node 22 Alpine, runs as non-root `node`) |
| Port | 8100, plain HTTP inside; TLS terminates at the company proxy |
| Storage | a small persistent volume at `/data` (settings, device registry, audit log; a few MB) |
| Health | `GET /healthz` → `{"ok":true}` |
| Outbound | `api.anthropic.com` (and `api.openai.com` if the OpenAI voice is used) |
| Inbound | HTTPS from employees' phones and laptops, e.g. published through your zero-trust network (Twingate, Tailscale, Cloudflare Access…) or behind company SSO; must allow WebSocket upgrade on `/agent/ws` |

Environment (already set in the image): `AURA_SERVER=1`, `AURA_HOST=0.0.0.0`, `AURA_PORT=8100`, `AURA_HUB_DATA=/data`.
API keys are entered in the app (System → Assistant / Voice) and stored in `/data/settings.json`, readable only by the container user.
Alternatively, provide them as `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` secrets.

```bash
docker build -t aura-hub .
docker run -d --name aura-hub -p 8100:8100 -v aura-data:/data aura-hub
docker logs aura-hub   # prints the one-time setup code for the first PIN
```

## First sign-in
In server mode, nobody is "at the computer", so the first PIN needs the **one-time setup code**
printed in the hub log. After that, only the PIN is needed. Five wrong PINs from one address lock that
address out for 15 minutes. The proxy's `X-Forwarded-For` is trusted in server mode.

## Connecting a laptop
On the laptop:
```bash
./install.sh --hub=https://aura.<company-domain>
```
Windows:
```powershell
.\install.ps1 -Hub https://aura.<company-domain>
```
It shows a pairing code, which you enter in Aura on the phone (System → Pair). From then on the agent connects out
at login, proves its identity with its Ed25519 device key, and enforces the laptop's own permission
switches (http://127.0.0.1:8101 on the laptop) on every action.

## Security summary for review
- **Network:** laptops never accept incoming connections. The agent only connects outbound to the hub.
- **Sign-in:** PIN (scrypt-hashed) with per-address lockout. Session cookies are `HttpOnly; Secure; SameSite=Strict`, and cross-site POSTs are rejected. A single shared PIN suits one user. For several users, replace it with company SSO: the hub already separates owners per device, and `hub/auth.js` is the one file to swap.
- **Devices:** each laptop pairs with a short-lived code. After that, every connection must sign a fresh challenge with the device key, and removing a device cuts it off at once.
- **Actions:** reading is automatic. Sending messages, acting in web apps and shell commands each need an Approve tap on the phone. The laptop can also switch each capability off locally, and the hub cannot override that.
- **Audit:** every action is logged on the hub (`/data/audit.jsonl`) and on the laptop (`~/.aura-agent/audit.jsonl`).
- **Data:** the hub keeps the latest snapshot per device (calendar, unread email and Slack summaries, system status), the chat history and notes. Content goes to the configured AI provider only when the user asks something.
