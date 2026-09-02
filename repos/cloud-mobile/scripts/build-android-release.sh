#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACT_DIR="$PROJECT_ROOT/.build-artifacts"

if [[ ! -x "$PROJECT_ROOT/android/gradlew" ]]; then
  echo "错误：未找到 android/gradlew，请先运行 npx expo prebuild --platform android。" >&2
  exit 1
fi

NODE_EXECUTABLE="$(command -v node || true)"
if [[ -z "$NODE_EXECUTABLE" ]]; then
  echo "错误：未找到 Node.js。" >&2
  exit 1
fi

if [[ -z "${JAVA_HOME:-}" ]]; then
  if [[ -x /usr/libexec/java_home ]] && /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
    JAVA_HOME="$(/usr/libexec/java_home -v 17)"
  elif [[ -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]]; then
    JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  else
    echo "错误：未找到 JDK 17，请安装后设置 JAVA_HOME。" >&2
    exit 1
  fi
fi
export JAVA_HOME

if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -d "$HOME/Library/Android/sdk" ]]; then
    ANDROID_HOME="$HOME/Library/Android/sdk"
  elif [[ -d /opt/homebrew/share/android-commandlinetools ]]; then
    ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
  else
    echo "错误：未找到 Android SDK，请设置 ANDROID_HOME。" >&2
    exit 1
  fi
fi
export ANDROID_HOME
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"

APP_VERSION="$("$NODE_EXECUTABLE" -p "require(process.argv[1]).version" "$PROJECT_ROOT/package.json")"
APK_SOURCE="$PROJECT_ROOT/android/app/build/outputs/apk/release/app-release.apk"
APK_OUTPUT="$ARTIFACT_DIR/Cloud-$APP_VERSION-android-release.apk"

mkdir -p "$ARTIFACT_DIR"
rm -f -- "$APK_OUTPUT"

echo "正在构建 Android Release APK..."
(
  cd "$PROJECT_ROOT/android"
  NODE_ENV=production ./gradlew assembleRelease --no-daemon \
    -Dorg.gradle.internal.http.connectionTimeout=20000 \
    -Dorg.gradle.internal.http.socketTimeout=30000 \
    --console=plain
)

if [[ ! -f "$APK_SOURCE" ]]; then
  echo "错误：Gradle 构建完成，但未找到 $APK_SOURCE。" >&2
  exit 1
fi

cp "$APK_SOURCE" "$APK_OUTPUT"
echo "Android Release APK 已生成：$APK_OUTPUT"
