# Atlas

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

- **hub/**: serves the phone UI, PIN sign-in (to be replaced by company SSO when it goes multi-user), device pairing and routing, the AI assistant, approvals, and the audit log (`~/.atlas-hub`).
- **agent/**: runs on the work computer **as the user** (never as admin). It dials out to the hub, so no port is opened. It proves its identity with an Ed25519 device key (`~/.atlas-agent`, owner-only), and it checks **its own local policy** before every action.
- **bridge/**: one Chrome / Edge / Brave extension that gives Atlas read access to every web app you're already signed in to (Gmail, Outlook, Calendar, Slack, Teams, Jira…). There's nothing to link app by app. It connects to the agent by itself, and desktop apps are covered by screen view.

## Install (one time, no admin, nothing to install first)

The installer gets everything it needs, including its own copy of Node.js from nodejs.org (checksum-verified), pairs the computer, adds an **Atlas** icon, and starts Atlas at login.

**Windows:** open PowerShell and paste:
```powershell
irm https://raw.githubusercontent.com/MarshallStunt/aura/main/install.ps1 | iex
```
If you downloaded the folder, double-click **Install Atlas (Windows).cmd** instead.

**Mac / Linux:** open Terminal and paste:
```bash
curl -fsSL https://raw.githubusercontent.com/MarshallStunt/aura/main/install.sh | sh
```
If you downloaded the folder, double-click **Install Atlas (Mac).app** instead. If it came from a zip, right-click it and choose **Open** the first time.

During setup, Atlas opens in your browser. Set a PIN there, go to **System**, and type the pairing code the installer shows. At the end:
- **Atlas icon:** on your Desktop and in Applications or the Start menu. It opens Atlas in its own window.
- **Browser extension (once):** the extensions page and the `bridge` folder open for you. Turn on **Developer mode**, click **Load unpacked**, and pick that folder. It connects by itself.

To pair with a hub hosted elsewhere: run `ATLAS_HUB=https://HUB` before the Mac line, or `$env:ATLAS_HUB="https://HUB"` before the Windows line.

## Opening it on your phone

**On a company laptop** (IT blocks incoming connections): run the hub on company infrastructure and point the laptop's agent at it. See [DEPLOY.md](DEPLOY.md).

**On a machine you control:**

The hub only listens on 127.0.0.1. Reach it privately over Tailscale (company-approved VPN) — check with IT first:
```bash
tailscale serve --bg 8100
```
Open the `https://<computer>.<tailnet>.ts.net` address on your phone, sign in with your PIN, and use
**Share → Add to Home Screen** so it opens like an app. Voice input needs HTTPS, which Tailscale provides.
If POSTs get blocked as cross-site behind the proxy, start the hub with `ATLAS_TAILNET_HOST=<computer>.<tailnet>.ts.net`.

## Apps per computer

In **System → Apps**, each computer chooses which apps Atlas uses. Gmail, Google Calendar and Slack are synced to the dashboard by default.
**Outlook (Microsoft 365, e.g. school or work accounts)** is off by default. Turn it on for the computer where you use it: Atlas keeps two pinned Outlook tabs (inbox and calendar) in that browser and shows the mail and meetings alongside Gmail.
Apps that are off are never synced, opened or read.

## Spaces (work and personal)

Every browser (or browser profile) with Atlas Bridge is its own **space**, with its own accounts, app choices and data.
Install the extension in a second browser and it shows up as a new space. Rename it (e.g. **Personal**) in **System → Spaces & apps**.
At the top of **Now**, switch between **All**, **Work** and **Personal**. The briefing, the lists and the assistant follow that choice.
A **private** space is never mixed into All: it's shown, and used by the assistant, only when you pick it.

## AI providers

Choose under **Devices → Assistant**: Anthropic Claude (default `claude-opus-5-5`), OpenAI, Google Gemini,
xAI Grok, Lambda Inference, Groq, OpenRouter, Mistral, DeepSeek, Ollama or LM Studio (local).
Keys are stored on the hub only (`~/.atlas-hub/settings.json`, owner-only) and never sent back to the page.
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
4. **Audit:** every action is logged on the hub (`~/.atlas-hub/audit.jsonl`, visible under Devices → Activity log) and on the computer (`~/.atlas-agent/audit.jsonl`). Removing a device on the phone cuts it off immediately.

Content from email, chat and web pages is treated as data, never as instructions to the assistant.

## Not done yet
- Company SSO and a shared hub for several people (the code is already split into hub and agent for this).
- Passkey / Face ID step-up for high-risk approvals; push notifications to the phone.
- The agent keeps its device key in a file (owner-only); moving it to Keychain / Credential Manager is next.
- Windows and Linux code paths are written but haven't been run on those systems yet.
