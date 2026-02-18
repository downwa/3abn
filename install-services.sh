#!/bin/bash
set -e

# Define paths
APP_DIR="$HOME/src/3abn"
RECORDER_SCRIPT="$APP_DIR/threeabn-recorder.js"
PLAYER_SCRIPT="$APP_DIR/threeabn-player.js"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

# Ensure user systemd directory exists
mkdir -p "$SYSTEMD_USER_DIR"

# Volume Guardian Service (User Level)
cat <<EOF > "$SYSTEMD_USER_DIR/threeabn-volume-guardian.service"
[Unit]
Description=3ABN volume guardian

[Service]
ExecStart=$APP_DIR/threeabn-volume-guardian.sh
Restart=always

[Install]
WantedBy=default.target
EOF

# Recorder Service (User Level)
cat <<EOF > "$SYSTEMD_USER_DIR/threeabn-recorder.service"
[Unit]
Description=3ABN Radio Recorder Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/env node $RECORDER_SCRIPT
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

# Player Service (User Level)
cat <<EOF > "$SYSTEMD_USER_DIR/threeabn-player.service"
[Unit]
Description=3ABN Radio Player Service
After=network.target sound.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/env node $PLAYER_SCRIPT
Restart=always
RestartSec=10
Environment=DISPLAY=:0
# Running as user service automatically inherits XDG_RUNTIME_DIR for audio

[Install]
WantedBy=default.target
EOF

# Ecreso Transmitter Service (User Level)
cat <<EOF > "$SYSTEMD_USER_DIR/ecreso-keepalive.service"
[Unit]
Description=Ecreso Transmitter Keepalive Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/env node ecreso-keepalive.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

# Reload and Enable
echo "Reloading user systemd..."
systemctl --user daemon-reload

echo "Services installed to $SYSTEMD_USER_DIR"
echo ""
echo "IMPORTANT: You should stop any running system-level services first:"
echo "  sudo systemctl stop threeabn-recorder threeabn-player"
echo "  sudo systemctl disable threeabn-recorder threeabn-player"
echo ""
echo "Then enable and start the user services:"
echo "  systemctl --user enable --now threeabn-recorder"
echo "  systemctl --user enable --now threeabn-player"
echo "  systemctl --user enable --now ecreso-keepalive"
echo "  systemctl --user enable --now threeabn-volume-guardian"
echo ""
echo "To ensure these run on boot without login, enable lingering:"
echo "  loginctl enable-linger $USER"
