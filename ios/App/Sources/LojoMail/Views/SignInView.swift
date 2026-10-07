import LojoMailCore
import SwiftUI
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
            VStack(spacing: 28) {
                header
                VStack(alignment: .leading, spacing: 14) {
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
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

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
                .font(.system(size: logoSize, weight: .regular))
                .foregroundStyle(Theme.accent.gradient)
                .padding(.top, 40)
                .accessibilityHidden(true)
            Text("LOJO Mail").font(.largeTitle.bold())
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
    @State private var importing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Mail is sealed to your envelope key, **envelope.private.jwk**, and opened only on this iPhone. Load it once; it stays in this iPhone's Keychain.")
                        .font(.subheadline)
                }
                Section {
                    Button { importing = true } label: {
                        Label("Choose from Files…", systemImage: "folder")
                    }
                    PasteButton(payloadType: String.self) { strings in
                        if let first = strings.first {
                            Task { @MainActor in save(first, fromClipboard: true) }
                        }
                    }
                    .labelStyle(.titleAndIcon)
                } header: {
                    Text("Load the key")
                } footer: {
                    Text("Paste clears the clipboard once the key is saved.")
                }
                Section("Other ways to get it here") {
                    step("airplane.circle", "AirDrop", "From your Mac, AirDrop envelope.private.jwk to this iPhone and choose LOJO Mail.")
                    step("square.and.arrow.up", "Share or Open in", "In Files, Mail or any app, share the file and pick LOJO Mail (or \"Open in LOJO Mail\").")
                    step("cable.connector", "USB from Santa Computa", "Run ios/scripts/provision-phone.sh; the app picks the key up on its next launch.")
                }
                Section {
                    SecretField(title: "Paste or type the JWK", text: $text, noun: "key", contentType: nil, multiline: true) {
                        save(text, fromClipboard: false)
                    }
                    Button("Save to Keychain") { save(text, fromClipboard: false) }
                        .disabled(text.isEmpty)
                } header: {
                    Text("Or enter it by hand")
                } footer: {
                    Text("Hidden while you type; tap the eye to check it. Stored in the iOS Keychain for this device only: not synced to iCloud, not in backups, and readable only while the iPhone is unlocked. You can replace or remove it later in Settings → Decryption.")
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
                        saved(fromClipboard: false)
                    } catch {
                        self.error = error.localizedDescription
                    }
                case .failure(let failure):
                    error = failure.localizedDescription
                }
            }
        }
    }

    static let importTypes: [UTType] = [.jwk, .json, .plainText, .data]

    private func step(_ icon: String, _ title: String, _ detail: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: icon).foregroundStyle(Theme.accent)
        }
        .accessibilityElement(children: .combine)
    }

    private func save(_ value: String, fromClipboard: Bool) {
        do {
            try model.importKey(value)
            saved(fromClipboard: fromClipboard)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func saved(fromClipboard: Bool) {
        text = ""
        error = nil
        if fromClipboard { UIPasteboard.general.string = "" }
        Haptics.success()
        model.toast = Toast(text: fromClipboard ? "Key saved. Clipboard cleared." : "Key saved to Keychain", systemImage: "key.fill")
        dismiss()
    }
}

extension UTType {
    /// `.jwk` files. Declared in Info.plist (UTImportedTypeDeclarations) so Files, AirDrop and the share sheet offer LOJO Mail.
    static let jwk = UTType(importedAs: "com.lojo.jwk", conformingTo: .json)
}
