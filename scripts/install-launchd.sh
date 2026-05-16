#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$PROJECT_ROOT/launchd/com.user.mtv.daily.plist.template"
TARGET="$HOME/Library/LaunchAgents/com.user.mtv.daily.plist"
BUN_PATH="$(command -v bun)"
if [[ -z "$BUN_PATH" ]]; then
  echo "bun not found in PATH" >&2; exit 1
fi
BUN_DIR="$(dirname "$BUN_PATH")"

mkdir -p "$PROJECT_ROOT/data/logs"
mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s|__BUN_PATH__|$BUN_PATH|g" \
  -e "s|__BUN_DIR__|$BUN_DIR|g" \
  -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
  "$TEMPLATE" > "$TARGET"

launchctl unload "$TARGET" 2>/dev/null || true
launchctl load "$TARGET"

echo "Installed launchd job at $TARGET"
echo "Will run daily at 08:00 local time."
echo "To run immediately: launchctl start com.user.mtv.daily"
echo "To uninstall: launchctl unload $TARGET && rm $TARGET"
