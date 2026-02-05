# gigboard Discord Gig Bot

A Discord bot for posting gigs to configured channels with applications, reports, and cleanup.

## Features
- Category based gig posting with per channel targets
- Apply and report flows with mod controls
- Role based access for creators, applicants, and moderators
- Per channel cooldown and expiry policies
- Daily cleanup of expired gigs and stale instances
- Error reporting and health check command

## Commands
- /health
- /category create|delete|list|show|add-target|remove-target|add-report|remove-report
- /roles add-moderator|remove-moderator|add-applicant|remove-applicant|add-direct-applicant|remove-direct-applicant|add-creator|remove-creator|list
- /channel set-expiry|clear-expiry|set-cooldown|clear-cooldown

## Setup
1. Create a folder and clone the repo
2. Install Node.js and npm
3. Install dependencies
4. Create `.env`
5. Start the bot

### Local Install (Ubuntu or Debian)
1. Create a folder and clone
```bash
mkdir -p /opt/gigboard
cd /opt/gigboard
git clone <your-repo-url> .
```
2. Install Node.js and npm
```bash
sudo apt update
sudo apt install -y nodejs npm
node -v
npm -v
```
3. Install dependencies
```bash
npm install
```
4. Create `.env`
```bash
cp .env.example .env
```
5. Start the bot
```bash
npm start
```

### Systemd Service (Ubuntu or Debian)
Save this script as `scripts/install-service.sh`, edit `REPO_URL`, then run it with `bash scripts/install-service.sh`.
```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_URL="<your-repo-url>"
APP_DIR="/opt/gigboard"
SERVICE_NAME="gigboard-bot"
USER_NAME="${SUDO_USER:-$USER}"

if ! command -v node >/dev/null 2>&1; then
  sudo apt update
  sudo apt install -y nodejs npm
fi

sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER_NAME":"$USER_NAME" "$APP_DIR"

if [ ! -f "$APP_DIR/package.json" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
npm install

sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=gigboard Discord Gig Bot
After=network.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node ${APP_DIR}/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.service"
sudo systemctl status "${SERVICE_NAME}.service" --no-pager
```

## The bot will create two concise database files and regularly self-clean.
- `config.db` stores roles, categories, channel mappings, and channel policies
- `tracking.db` stores gigs, message instances, applications, reports, rate limits, and cleanup log
