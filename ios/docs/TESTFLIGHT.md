# LOJO Mail TestFlight

The **iOS** GitHub Action generates the Xcode project, runs unit tests, and walks every screen with UI tests on every pull request. Those pull requests do not sign or upload. A push to `main`, or a manual run of the **iOS** workflow, uploads to TestFlight from a separate job that waits for the unit tests and the UI tests. Cloud signing is not used. The run imports the shared iOS Distribution certificate (`DIST_CERT_P12`) into a temporary keychain, signs manually with that certificate, and fetches or creates an App Store profile per archive bundle id through the App Store Connect API. Profiles are tied to certificate `VJ5MXTN7UT`. The run does not create or revoke certificates. An `always()` step deletes the temporary keychain and the imported certificate whether the upload worked or not.

The workflow runs on `macos-26` and selects Xcode 26 (`Xcode_26.6.app`, then `Xcode_26.app`, then `Xcode.app`). USB installs from Santa Computa still use xtool and a free Apple ID. That sideloaded app is `XTL-N9H4648NB9.com.lojo.Mail`. TestFlight is a different app: `com.lojo.Mail`, signed by the paid team in the `DEVELOPMENT_TEAM` secret. The envelope key in one does not appear in the other. Load the key once in the TestFlight app. The sideloaded app's key is not removed.

The free team `N9H4648NB9` cannot be used on App Store Connect.

## What you do in Apple Developer and App Store Connect

Do this once. The GitHub Action cannot create the App ID or the App Store Connect app record.

### 1. Create the App ID

1. Open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) while signed into the **paid** Apple Developer team (the same team as Watch Remote, not the free `N9H4648NB9` team).
2. Click **+**.
3. Select **App IDs** → **Continue**.
4. Select **App** → **Continue**.
5. Description: `LOJO Mail`.
6. Bundle ID: **Explicit** → `com.lojo.Mail`.
7. Capabilities: leave them off. Background fetch is an Info.plist key. Push is still not used.
8. **Continue** → **Register**.

### 2. Create the app record

1. Open [App Store Connect → Apps](https://appstoreconnect.apple.com/apps).
2. Click **+** → **New App**.
3. Platforms: **iOS**.
4. Name: `LOJO Mail`.
5. Primary language: **English (US)**.
6. Bundle ID: **com.lojo.Mail**.
7. SKU: `lojo-mail`.
8. User Access: **Full Access**.
9. **Create**.

### 3. GitHub secrets

Reuse the same App Store Connect API key and signing secret names as [lojo-watch-remote](https://github.com/macdadyj/lojo-watch-remote). If this repository does not already have them, add them here (same values as Watch Remote). The commands do not include secret values.

```bash
gh secret set ASC_KEY_ID
gh secret set ASC_ISSUER_ID
base64 < AuthKey_XXXXXXXXXX.p8 | gh secret set ASC_KEY_P8
gh secret set DEVELOPMENT_TEAM
base64 < distribution.p12 | gh secret set DIST_CERT_P12
gh secret set DIST_CERT_PASSWORD
```

`DEVELOPMENT_TEAM` is the paid Apple team id. It is a GitHub secret, injected when the archive runs, and it is not written in this repository. `ASC_KEY_P8` may be the `.p8` file as base64 (line breaks are fine) or PKCS#8 PEM text (the usual BEGIN PRIVATE KEY header). `DIST_CERT_P12` is the shared iOS Distribution certificate (certificate id `VJ5MXTN7UT`) as base64 of the `.p12`, and `DIST_CERT_PASSWORD` is that file's password. The account allows two iOS Distribution certificates, so the workflow reuses this one instead of creating another. Profiles come from the API and must contain the imported certificate. Do not pass `-allowProvisioningUpdates` to xcodebuild: that flag lets Xcode create certificates.

The build number is the GitHub run number plus 10 (run 1 uploads build 11), so it stays above the local USB build `2`. A re-run of the same run appends the attempt, for example `15.2`. Settings shows **Version 0.1 (build N)**. Both Info plists set `ITSAppUsesNonExemptEncryption` to false.

A manual run of the **TestFlight beta** workflow can put an already-uploaded build in the internal group.

## Local generate

```bash
brew install xcodegen
cd ios && xcodegen generate
```

The generated `ios/LojoMail.xcodeproj` is gitignored. xtool USB installs are unchanged: `ios/scripts/deploy-phone.sh`.
