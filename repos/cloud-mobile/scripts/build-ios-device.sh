#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACT_DIR="$PROJECT_ROOT/.build-artifacts"
PBXPROJ="$PROJECT_ROOT/ios/Cloud.xcodeproj/project.pbxproj"

if [[ ! -d "$PROJECT_ROOT/ios/Cloud.xcworkspace" ]]; then
  echo "错误：未找到 ios/Cloud.xcworkspace，请先运行 npx expo prebuild --platform ios。" >&2
  exit 1
fi

if [[ -f "$PROJECT_ROOT/ios/Podfile.lock" ]] && ! cmp -s "$PROJECT_ROOT/ios/Podfile.lock" "$PROJECT_ROOT/ios/Pods/Manifest.lock"; then
  echo "检测到 CocoaPods 依赖未同步��Podfile.lock 与 Pods/Manifest.lock 不一致），正在执行 pod install..."
  if command -v pod >/dev/null 2>&1; then
    (cd "$PROJECT_ROOT/ios" && pod install)
  else
    echo "错误：Podfile.lock 与 Pods/Manifest.lock 不一致，且未找到 pod 命令，请安装 CocoaPods 后执行 pod install。" >&2
    exit 1
  fi
fi

NODE_EXECUTABLE="${NODE_BINARY:-$(command -v node || true)}"
if [[ -z "$NODE_EXECUTABLE" ]]; then
  echo "错误：未找到 Node.js，请安装 Node.js 或设置 NODE_BINARY。" >&2
  exit 1
fi

APP_VERSION="$("$NODE_EXECUTABLE" -p "require(process.argv[1]).version" "$PROJECT_ROOT/package.json")"
DETECTED_TEAM="$(awk '/DEVELOPMENT_TEAM = / { gsub(/;/, "", $3); print $3; exit }' "$PBXPROJ")"
DEVELOPMENT_TEAM="${IOS_DEVELOPMENT_TEAM:-$DETECTED_TEAM}"

if [[ -z "$DEVELOPMENT_TEAM" ]]; then
  echo "错误：未找到 Apple Development Team，请设置 IOS_DEVELOPMENT_TEAM。" >&2
  exit 1
fi

ARCHIVE_PATH="$ARTIFACT_DIR/Cloud-$APP_VERSION-device.xcarchive"
EXPORT_DIR="$ARTIFACT_DIR/ios-device-export"
EXPORT_OPTIONS="$ARTIFACT_DIR/ExportOptions-debugging.plist"
IPA_OUTPUT="$ARTIFACT_DIR/Cloud-$APP_VERSION-ios-device.ipa"

remove_generated_path() {
  local target="$1"
  case "$target" in
    "$ARTIFACT_DIR"/*) rm -rf -- "$target" ;;
    *)
      echo "错误：拒绝清理构建目录之外的路径：$target" >&2
      exit 1
      ;;
  esac
}

mkdir -p "$ARTIFACT_DIR"
remove_generated_path "$ARCHIVE_PATH"
remove_generated_path "$EXPORT_DIR"
remove_generated_path "$IPA_OUTPUT"

cat > "$EXPORT_OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>destination</key>
    <string>export</string>
    <key>method</key>
    <string>debugging</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>teamID</key>
    <string>$DEVELOPMENT_TEAM</string>
    <key>stripSwiftSymbols</key>
    <true/>
</dict>
</plist>
PLIST

echo "正在归档 iOS 真机 Release（Team: ${DEVELOPMENT_TEAM}）..."
(
  cd "$PROJECT_ROOT"
  NODE_BINARY="$NODE_EXECUTABLE" NODE_ENV=production xcodebuild \
    -workspace ios/Cloud.xcworkspace \
    -scheme Cloud \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_PATH" \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
    CODE_SIGN_STYLE=Automatic \
    -allowProvisioningUpdates \
    archive
)

echo "正在导出开发签名 IPA..."
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates

IPA_SOURCE="$(find "$EXPORT_DIR" -maxdepth 1 -type f -name '*.ipa' -print -quit)"
if [[ -z "$IPA_SOURCE" ]]; then
  echo "错误：Xcode 导出完成，但未找到 IPA。" >&2
  exit 1
fi

cp "$IPA_SOURCE" "$IPA_OUTPUT"
echo "iOS 真机 IPA 已生成：$IPA_OUTPUT"
