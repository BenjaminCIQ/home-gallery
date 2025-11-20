#!/usr/bin/env bash
set -e

# ============================================================
# 0. Required privileges
# ============================================================
if [[ $EUID -ne 0 ]]; then
    echo "This setup script must be run as root (sudo)."
    exit 1
fi

# ============================================================
# 1. Environment
# ============================================================
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$BASE_DIR/sync-config.yml"
SYSTEMD_DIR="/etc/systemd/system"

SERVICE_TEMPLATE="$BASE_DIR/photoframe-sync@.service"
TIMER_UNIT="$BASE_DIR/photoframe-sync.timer"
PATH_GENERATOR="$BASE_DIR/generate-path-units.py"
SYNC_SCRIPT="$BASE_DIR/folder-sync.py"
REAL_USER="${SUDO_USER:-$USER}"
REAL_GROUP=$(id -gn "$REAL_USER")

echo "Base directory: $BASE_DIR"
echo "Config file: $CONFIG_FILE"
echo "Systemd directory: $SYSTEMD_DIR"

# ============================================================
# 2. Create virtualenv
# ============================================================
VENV_DIR="$BASE_DIR/venv"

if [[ ! -d "$VENV_DIR" ]]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

echo "Installing Python requirements..."
"$VENV_DIR/bin/pip" install -r "$BASE_DIR/requirements.txt"

# ============================================================
# 3. Generate path units
# ============================================================
echo "Generating path units..."
"$VENV_DIR/bin/python3" "$PATH_GENERATOR" --config "$CONFIG_FILE" --output-dir "$BASE_DIR"

# ============================================================
# 4. Install service template
# ============================================================
echo "Installing service template..."
cp "$SERVICE_TEMPLATE" "$SYSTEMD_DIR/photoframe-sync@.service"

echo "Updating ExecStart, User and Group..."
sed -i.bak \
    "s@^ExecStart=.*@ExecStart=$VENV_DIR/bin/python3 $SYNC_SCRIPT -c $CONFIG_FILE -s %i@" \
    "$SERVICE_TEMPLATE"

sed -i \
    "s/^User=.*/User=$REAL_USER/" \
    "$SERVICE_TEMPLATE"

sed -i \
    "s/^Group=.*/Group=$REAL_GROUP/" \
    "$SERVICE_TEMPLATE"

# ============================================================
# 5. Install timer
# ============================================================
echo "Installing timer unit..."
cp "$TIMER_UNIT" "$SYSTEMD_DIR/photoframe-sync.timer"

# ============================================================
# 6. Install path units
# ============================================================
echo "Installing path units..."
for path_unit in "$BASE_DIR"/*.path; do
    [ -f "$path_unit" ] || continue

    dest_unit="$SYSTEMD_DIR/$(basename "$path_unit")"
    cp "$path_unit" "$dest_unit"

    echo "Enabling path unit: $(basename "$path_unit")"
    systemctl enable "$(basename "$path_unit")"
    systemctl start "$(basename "$path_unit")"
done

# ============================================================
# 7. Reload systemd and enable timer
# ============================================================
echo "Reloading systemd daemon..."
systemctl daemon-reload

echo "Enabling and starting timer..."
systemctl enable photoframe-sync.timer
systemctl start  photoframe-sync.timer
sudo systemctl start photoframe-sync@timer.service

echo "Setup complete!"
echo "All system-level units installed, enabled, and running."