# Android 与 macOS 自动构建发布

仓库通过两个独立的 GitHub Actions Workflow 构建客户端：

- `.github/workflows/android.yml`
- `.github/workflows/macos.yml`

普通 `main` push、Pull Request 和手动触发只执行测试与 CI 打包。正式发布由平台 Tag 触发。Android Tag 必须配置签名 Secrets；macOS 在 Apple Secrets 未配置时会发布带 `unsigned` 标记的 Pre-release ZIP。

## Android

### CI 产物

未配置签名 Secrets 时，普通 CI 仍会构建 unsigned Release APK/AAB，并上传到对应 Actions Run 的 Artifacts。

### 签名 Secrets

在 GitHub 仓库 `Settings → Secrets and variables → Actions` 中配置：

| Secret | 说明 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Release keystore 文件的 Base64 内容 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 签名 key alias |
| `ANDROID_KEY_PASSWORD` | 签名 key 密码 |

生成 Base64：

```bash
base64 < release.keystore | tr -d '\n'
```

### 发布

```bash
git tag android-v0.1.0
git push origin android-v0.1.0
```

Workflow 使用 Tag 中的版本作为 `versionName`，使用 GitHub Run Number 作为 `versionCode`，生成签名 APK/AAB 并上传到同名 GitHub Release。

## macOS

### CI 产物

普通 CI 使用 `CODE_SIGNING_ALLOWED=NO` 执行单元测试并生成 unsigned ZIP，仅用于内部验证。推送 `mac-v*` Tag 时，如果 Apple 签名 Secrets 全部缺失，也会发布带 `unsigned` 标记的 Pre-release ZIP；只配置部分 Secrets 会直接失败。

### 签名和公证 Secrets

| Secret | 说明 |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Developer ID Application 证书及私钥导出的 `.p12` Base64 |
| `MACOS_CERTIFICATE_PASSWORD` | `.p12` 密码 |
| `MACOS_SIGNING_IDENTITY` | 完整签名 identity，例如 `Developer ID Application: Example (TEAMID)` |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_API_KEY_ID` | App Store Connect API Key ID |
| `APPLE_API_ISSUER_ID` | App Store Connect Issuer ID |
| `APPLE_API_PRIVATE_KEY_BASE64` | `AuthKey_XXX.p8` 的 Base64 内容 |

生成 Base64：

```bash
base64 < DeveloperID.p12 | tr -d '\n'
base64 < AuthKey_XXX.p8 | tr -d '\n'
```

### 发布

```bash
git tag mac-v0.1.0
git push origin mac-v0.1.0
```

Apple 签名 Secrets 完整时，Workflow 将执行：

1. Swift Package 依赖解析和单元测试。
2. 导入临时 Developer ID keychain。
3. Archive 和签名 `.app`。
4. 使用 `notarytool` 公证并 staple 应用。
5. 生成 ZIP 和 DMG，再对 DMG 公证和 staple。
6. 上传 Actions Artifact 和同名 GitHub Release。

Apple 签名 Secrets 全部缺失时，Workflow 会跳过签名和公证，仅生成 `CCAgent-<version>-macOS-unsigned.zip`，并把 GitHub Release 标记为 Pre-release。

## 手动运行

两个 Workflow 都支持 GitHub Actions 页面中的 `Run workflow`。手动运行属于 CI 构建，不会创建 GitHub Release；正式发布必须推送对应平台 Tag。
