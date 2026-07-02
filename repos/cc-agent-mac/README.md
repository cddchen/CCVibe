# CCAgent (macOS)

Native SwiftUI client for [cc-agent-daemon](../cc-agent-daemon), mirroring the web frontend.

## Requirements

- macOS 14+
- Xcode 16+ (Liquid Glass uses `#available(macOS 26, *)` with material fallback on older OS)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`

## Build

```bash
cd repos/cc-agent-mac
xcodegen generate
open CCAgent.xcodeproj
# ⌘B to build, ⌘R to run
```

Or:

```bash
xcodebuild -scheme CCAgent -destination 'platform=macOS' build
```

## Login

- Host, port (default **4733**), optional TLS (wss), and daemon token.
- Credentials: token in Keychain, WS base in UserDefaults (same keys as web intent).

## Tests

```bash
xcodebuild -scheme CCAgent -destination 'platform=macOS' test
```