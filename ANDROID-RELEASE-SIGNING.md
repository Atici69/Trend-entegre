# Android release APK signing

The Android workflow always builds a debug APK. It builds and uploads a signed release APK only when all four repository Actions secrets below are configured.

## 1. Create the upload/signing key once (Windows)

Install a JDK if `keytool` is not available, then run this in PowerShell in a private folder:

```powershell
keytool -genkeypair -v -keystore trend-entegre-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias trend-entegre
```

Choose a strong keystore password and key password. Keep the alias and both passwords safe. Do not commit or upload the `.jks` file to the repository or send it in chat.

Create a Base64 value and copy it directly to the clipboard:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\trend-entegre-release.jks")) | Set-Clipboard
```

Keep at least two secure offline backups of the original `.jks` file. **Never regenerate this key for app updates**: Android requires updates to be signed with the same key.

## 2. Add GitHub Actions secrets

Open the repository's **Settings → Secrets and variables → Actions → New repository secret** and add these four secrets:

| Secret name | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Paste the Base64 value copied above |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | `trend-entegre` |
| `ANDROID_KEY_PASSWORD` | Password for the key |

Do not put these values in source files, workflow YAML, issues, or chat.

## 3. Build

After all four secrets are saved, run **Actions → Android APK build → Run workflow** on `main`, or push a commit to `main`.

The run uploads:
- `trend-entegre-debug-apk` — debug/test build
- `trend-entegre-release-apk` — signed release build (only when signing secrets are present)

Download the release APK from the successful workflow run's **Artifacts** section. The workflow never prints secret values to logs.
