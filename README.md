# Relay

Your work computer from your phone or tablet: meetings, email, chat, what's on screen, and voice
commands to get things done. Works with Windows, macOS and Linux computers, and lets you pick the AI provider.

```
 Phone / tablet ──HTTPS──►  HUB                     ◄── outbound WebSocket ──  AGENT (each computer)
  (browser, PWA)            sign-in, devices,                                   status · screen · commands
                            assistant, approvals,                               local policy + audit
                            audit log                                                 ▲
                                                                                      │ 127.0.0.1 only
                                                                              BROWSER EXTENSION
                                                                              any signed-in web app
```

- **hub/**: serves the phone UI, PIN sign-in (to be replaced by company SSO when it goes multi-user), device pairing and routing, the AI assistant, approvals, and the audit log (`~/.relay-hub`).
- **agent/**: runs on the work computer **as the user** (never as admin). It dials out to the hub, so no port is opened. It proves its identity with an Ed25519 device key (`~/.relay-agent`, owner-only), and it checks **its own local policy** before every action.
- **bridge/**: one Chrome / Edge / Brave extension that gives Relay read access to every web app you're already signed in to (Gmail, Outlook, Calendar, Slack, Teams, Jira…). There's nothing to link app by app. It connects to the agent by itself, and desktop apps are covered by screen view.

## Setup (one time)

macOS / Linux:
```bash
./install.sh
```
Windows (PowerShell, as yourself):
```powershell
.\install.ps1
```
The installer:
1. installs the dependencies (needs Node.js 20+);
2. starts the hub so you can set your PIN at http://127.0.0.1:8100 **on the computer itself**;
3. shows a pairing code, which you enter under **Devices**;
4. registers Relay to start at login (launchd / systemd user service / Task Scheduler).

Then load the `bridge` folder once per browser: open `chrome://extensions` or `edge://extensions`, turn on Developer mode, and click **Load unpacked**. For company-wide rollout, IT can force-install the extension instead.

To use a hub on another machine: `./install.sh --hub=https://HUB` or `.\install.ps1 -Hub https://HUB`.

Run by hand instead: `npm start` (hub and agent), or `npm run hub` / `npm run agent`.

## Opening it on your phone

The hub only listens on 127.0.0.1. Reach it privately over Tailscale (company-approved VPN) — check with IT first:
```bash
tailscale serve --bg 8100
```
Open the `https://<computer>.<tailnet>.ts.net` address on your phone, sign in with your PIN, and use
**Share → Add to Home Screen** so it opens like an app. Voice input needs HTTPS, which Tailscale provides.
If POSTs get blocked as cross-site behind the proxy, start the hub with `RELAY_TAILNET_HOST=<computer>.<tailnet>.ts.net`.

## AI providers

Choose under **Devices → Assistant**: Anthropic Claude (default `claude-opus-5-5`), OpenAI, Google Gemini,
xAI Grok, Lambda Inference, Groq, OpenRouter, Mistral, DeepSeek, Ollama or LM Studio (local).
Keys are stored on the hub only (`~/.relay-hub/settings.json`, owner-only) and never sent back to the page.
Every provider gets the same tools and the same approval rules. You can switch provider in the middle of a chat.

## Permissions, in layers

1. **OS:** the agent runs as you. On macOS, Screen Recording permission is granted by you.
2. **Local policy** at http://127.0.0.1:8101, which can only be changed at the computer (not from the phone):

   | Switch | Default |
   |---|---|
   | Computer status | on |
   | Read signed-in web apps | on |
   | Open links / drafts | on |
   | Notifications / lock | on |
   | View the screen | **off** |
   | Act in web apps (click, type, send) | **off** |
   | Shell commands | **off** |
3. **Per action:** reading runs by itself. Sending messages, acting in web apps, and running commands each show an **Approve / Deny** card on the phone.
4. **Audit:** every action is logged on the hub (`~/.relay-hub/audit.jsonl`, visible under Devices → Activity log) and on the computer (`~/.relay-agent/audit.jsonl`). Removing a device on the phone cuts it off immediately.

Content from email, chat and web pages is treated as data, never as instructions to the assistant.

## Not done yet
- Company SSO and a shared hub for several people (the code is already split into hub and agent for this).
- Passkey / Face ID step-up for high-risk approvals; push notifications to the phone.
- The agent keeps its device key in a file (owner-only); moving it to Keychain / Credential Manager is next.
- Windows and Linux code paths are written but haven't been run on those systems yet.
