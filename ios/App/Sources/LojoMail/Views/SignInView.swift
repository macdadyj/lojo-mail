import LojoMailCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var passphrase = ""
    @State private var account = ""
    @State private var keep = true
    @State private var busy = false
    @State private var error: String?
    @State private var showServer = false
    @State private var serverText = ""
    @ScaledMetric(relativeTo: .largeTitle) private var logoSize: CGFloat = 56

    var body: some View {
        ScrollView {
            VStack(spacing: 32) {
                header
                VStack(alignment: .leading, spacing: 16) {
                    VStack(spacing: 0) {
                        // The username half of the login form. The API only takes the passphrase, but password
                        // managers (iCloud Keychain, 1Password…) pair a .username field with the .password one to
                        // offer, save and fill the credential.
                        TextField("Account", text: $account)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.next)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 50)
                            .accessibilityLabel("Account")
                        Divider().padding(.leading, 14)
                        SecretField(title: "Passphrase", text: $passphrase, noun: "passphrase", submitLabel: .go) {
                            Task { await signIn() }
                        }
                        .padding(.leading, 14)
                        .padding(.trailing, 4)
                        .frame(minHeight: 50)
                    }
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                    Text("Your password manager can fill the passphrase: tap the field, then the key or Passwords button above the keyboard. Save it under \(model.mailbox) (website app.cyberphysical.us) to find it here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Toggle(isOn: $keep) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Keep me signed in")
                            Text("Stores the passphrase in this iPhone's Keychain so the 12-hour session renews itself and background checks keep working.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    } else if let reason = model.signOutReason {
                        Label(reason, systemImage: "clock.badge.exclamationmark")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }

                    Button {
                        Task { await signIn() }
                    } label: {
                        HStack {
                            if busy { ProgressView().tint(.white) }
                            Text(busy ? "Signing in…" : "Sign in").fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                        .disabled(passphrase.isEmpty || busy)
                        .accessibilityIdentifier("signin.submit")
                }

                DisclosureGroup(isExpanded: $showServer) {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("API URL", text: $serverText)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .font(.footnote.monospaced())
                        Button("Use this server") {
                            if let url = APIClient.validatedBaseURL(serverText) {
                                model.setAPIBase(url)
                                error = nil
                            } else {
                                error = "The API URL must be https."
                            }
                        }
                        .font(.footnote)
                    }
                    .padding(.top, 6)
                } label: {
                    Text("Server").foregroundStyle(.secondary)
                }
                .font(.footnote)

                    if model.key != nil {
                        Text("Your envelope key is still in the Keychain. Signing in again does not remove it.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    Text("Messages are sealed to your envelope key and are opened only on this iPhone. After signing in you'll load that key once.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear {
            serverText = model.apiBase.absoluteString
            if account.isEmpty { account = model.mailbox }
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Image(systemName: "envelope.badge.shield.half.filled")
                .font(.system(size: logoSize, weight: .medium, design: .rounded))
                .foregroundStyle(Theme.accent.gradient)
                .padding(.top, 48)
                .symbolEffect(.pulse, options: .nonRepeating)
                .accessibilityHidden(true)
            Text("LOJO Mail").font(.largeTitle.weight(.bold))
            Text(model.mailbox).font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private func signIn() async {
        guard !passphrase.isEmpty, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await model.signIn(passphrase: passphrase, keep: keep)
            passphrase = ""
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.warning()
        }
    }
}

/// Load `envelope.private.jwk` from Files, the clipboard, or by typing it. AirDrop and "Open in LOJO Mail" arrive
/// through `RootView.onOpenURL` instead. Whichever way, the key goes straight to the Keychain.
struct KeySetupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?
    @State private var guidance: String?
    @State private var importing = false
    @State private var retryTarget: UnlockButton.Action?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Mail is sealed to your envelope key, **envelope.private.jwk**, and opened only on this iPhone. Load it once; it stays in the Keychain and an app update does not drop it.")
                        .font(.subheadline)
                }
                Section {
                    ForEach(UnlockScreen.loadButtons) { button in
                        Button {
                            perform(button.action)
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(button.title).font(.subheadline.weight(.semibold))
                                    Text(UnlockScreen.detail(for: button.action))
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: button.systemImage).foregroundStyle(Theme.accent)
                            }
                        }
                        .accessibilityIdentifier(button.accessibilityIdentifier)
                    }
                } header: {
                    Text("Load the key")
                } footer: {
                    Text("Every option is a button. Paste clears the clipboard once the key is saved. USB imports a key that provision-phone.sh already copied onto this iPhone.")
                }
                Section {
                    SecretField(title: "Paste or type the JWK", text: $text, noun: "key", contentType: nil, multiline: true) {
                        perform(.saveTypedKey)
                    }
                    Button {
                        perform(UnlockScreen.saveButton.action)
                    } label: {
                        Label(UnlockScreen.saveButton.title, systemImage: UnlockScreen.saveButton.systemImage)
                    }
                    .accessibilityIdentifier(UnlockScreen.saveButton.accessibilityIdentifier)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: {
                    Text("Or enter it by hand")
                } footer: {
                    Text("Hidden while you type; tap the eye to check it. Stored in the iOS Keychain with AfterFirstUnlock, not in the app's files. You can replace or remove it later in Settings → Decryption.")
                }
                if let guidance {
                    Section {
                        Text(guidance)
                        Button {
                            perform(.retry)
                        } label: {
                            Label(UnlockScreen.retry.title, systemImage: UnlockScreen.retry.systemImage)
                        }
                        .accessibilityIdentifier(UnlockScreen.retry.accessibilityIdentifier)
                    }
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                }
            }
            .navigationTitle("Unlock your mail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Later") { dismiss() } }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: KeySetupView.importTypes) { result in
                switch result {
                case .success(let url):
                    do {
                        try model.importKey(fileAt: url)
                        saved(fromClipboard: false, toast: "Key saved to Keychain")
                    } catch {
                        self.error = error.localizedDescription
                        guidance = nil
                    }
                case .failure(let failure):
                    let ns = failure as NSError
                    if ns.domain == NSCocoaErrorDomain && ns.code == NSUserCancelledError { return }
                    error = failure.localizedDescription
                    guidance = UnlockScreen.missingGuidance(for: .chooseFromFiles)
                }
            }
        }
    }

    static let importTypes: [UTType] = [.jwk, .json, .plainText, .data]

    private func perform(_ action: UnlockButton.Action) {
        switch action {
        case .retry:
            if let retryTarget { perform(retryTarget) }
        case .chooseFromFiles:
            retryTarget = action
            importing = true
        case .pasteKey:
            retryTarget = action
            paste()
        case .airdrop, .shareOrOpenIn:
            retryTarget = action
            finish(model.importSharedKey(action: action), toast: "Key saved to Keychain")
        case .usbFromSantaComputa:
            retryTarget = action
            finish(model.importProvisionedUSB(), toast: "Unlocked with the key from Santa Computa.")
        case .saveTypedKey:
            retryTarget = action
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                error = nil
                guidance = UnlockScreen.missingGuidance(for: .saveTypedKey)
            } else {
                save(trimmed, fromClipboard: false)
            }
        }
    }

    private func paste() {
        guard let value = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            error = nil
            guidance = UnlockScreen.missingGuidance(for: .pasteKey)
            return
        }
        save(value, fromClipboard: true)
    }

    private func finish(_ result: UnlockImportResult, toast: String) {
        switch result {
        case .unlocked:
            saved(fromClipboard: false, toast: toast)
        case .missing(let message):
            error = nil
            guidance = message
        case .failed(let message):
            guidance = nil
            error = message
        }
    }

    private func save(_ value: String, fromClipboard: Bool) {
        do {
            try model.importKey(value)
            saved(fromClipboard: fromClipboard, toast: fromClipboard ? "Key saved. Clipboard cleared." : "Key saved to Keychain")
        } catch {
            self.error = error.localizedDescription
            guidance = nil
        }
    }

    private func saved(fromClipboard: Bool, toast: String) {
        text = ""
        error = nil
        guidance = nil
        if fromClipboard { UIPasteboard.general.string = "" }
        Haptics.success()
        model.toast = Toast(text: toast, systemImage: "key.fill")
        dismiss()
    }
}

extension UTType {
    /// `.jwk` files. Declared in Info.plist (UTImportedTypeDeclarations) so Files, AirDrop and the share sheet offer LOJO Mail.
    static let jwk = UTType(importedAs: "com.lojo.jwk", conformingTo: .json)
}
