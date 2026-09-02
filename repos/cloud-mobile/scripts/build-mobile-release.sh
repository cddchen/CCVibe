#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$SCRIPT_DIR/build-ios-device.sh"
bash "$SCRIPT_DIR/build-android-release.sh"

echo "双端安装包已全部生成到 $(cd "$SCRIPT_DIR/.." && pwd)/.build-artifacts"
