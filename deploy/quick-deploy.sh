#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <domain> [repo_url]"
  echo "Example: $0 chat.example.com https://github.com/cowbook/shytalk.git"
  exit 1
fi

DOMAIN="$1"
REPO_URL="${2:-https://github.com/cowbook/shytalk.git}"
APP_DIR="/opt/shytalk"
SERVICE_FILE="/etc/systemd/system/shytalk.service"
CADDY_FILE="/etc/caddy/Caddyfile"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)."
  exit 1
fi

echo "[1/8] Installing base packages..."
apt-get update
apt-get install -y curl git ca-certificates gnupg lsb-release

echo "[2/8] Installing Node.js 22..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1)" != "v22" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "[3/8] Installing Caddy..."
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

echo "[4/8] Deploying app source..."
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "[5/8] Installing app dependencies and building..."
cd "$APP_DIR"
npm ci
npm run build

mkdir -p "$APP_DIR/server/data"

if ! id -u shytalk >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/shytalk --shell /usr/sbin/nologin shytalk
fi
chown -R shytalk:shytalk "$APP_DIR/server/data"

echo "[6/8] Configuring systemd service..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ShyTalk Chat Service
After=network.target

[Service]
Type=simple
User=shytalk
Group=shytalk
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/npm run start -w server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable shytalk
systemctl restart shytalk

echo "[7/8] Configuring Caddy HTTPS reverse proxy..."
cat > "$CADDY_FILE" <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF

systemctl enable caddy
systemctl restart caddy

echo "[8/8] Done."
echo "Visit: https://$DOMAIN"
echo "If DNS is not ready yet, HTTPS issuance may be delayed until domain resolves to this server."
