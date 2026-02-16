#!/bin/bash
set -e

echo "Cleaning up legacy root-level services..."

# Define service names
SERVICES=("threeabn-recorder.service" "threeabn-player.service")

for SERVICE in "${SERVICES[@]}"; do
    if [ -f "/etc/systemd/system/$SERVICE" ]; then
        echo "Found system-level service: $SERVICE"
        
        # Stop if running
        if systemctl is-active --quiet "$SERVICE"; then
            echo "  Stopping $SERVICE..."
            sudo systemctl stop "$SERVICE"
        fi

        # Disable
        echo "  Disabling $SERVICE..."
        sudo systemctl disable "$SERVICE"

        # Remove file
        echo "  Removing /etc/systemd/system/$SERVICE..."
        sudo rm "/etc/systemd/system/$SERVICE"
        
        echo "  Removed $SERVICE."
    else
        echo "Root-level service $SERVICE not found (already clean)."
    fi
done

# Reload daemon
echo "Reloading systemd daemon..."
sudo systemctl daemon-reload

echo "Cleanup complete."
