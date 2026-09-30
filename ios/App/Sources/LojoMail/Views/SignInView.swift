import LojoMailCore
import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var passphrase = ""
    @State private var keep = true
    @State private var busy = false
    @State private var error: String?
    @State private var showServer = false
    @State private var serverText = ""
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                header
                VStack(alignment: .leading, spacing: 14) {
                    SecureField("Passphrase", text: $passphrase)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .focused($focused)
                        .onSubmit { Task { await signIn() } }
                        .padding(14)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .accessibilityLabel("Web app passphrase")

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

                DisclosureGroup("Server", isExpanded: $showServer) {
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
                }
                .font(.footnote)
                .foregroundStyle(.secondary)

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
        .onAppear { serverText = model.apiBase.absoluteString }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Image(systemName: "envelope.badge.shield.half.filled")
                .font(.system(size: 56, weight: .regular))
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

/// Paste or import `envelope.private.jwk`. The key goes straight to the Keychain.
struct KeySetupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?
    @State private var importing = false
    @State private var clearedClipboard = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Your mail is sealed to a P-256 envelope key that never leaves your devices. Paste the contents of **envelope.private.jwk** (the same text you paste into the web app's Settings), or import the file.")
                        .font(.subheadline)
                }
                Section("Envelope private key") {
                    TextEditor(text: $text)
                        .font(.footnote.monospaced())
                        .frame(minHeight: 120)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("Envelope private key JSON")
                    HStack {
                        PasteButton(payloadType: String.self) { strings in
                            if let first = strings.first {
                                Task { @MainActor in
                                    text = first
                                    save(fromClipboard: true)
                                }
                            }
                        }
                        .labelStyle(.titleAndIcon)
                        Spacer()
                        Button("Import file…") { importing = true }
                    }
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                }
                Section {
                    Button("Save to Keychain") { save(fromClipboard: false) }
                        .disabled(text.isEmpty)
                } footer: {
                    Text("Stored in the iOS Keychain for this device only: not synced to iCloud, not in backups, and readable only while the iPhone is unlocked.")
                }
            }
            .navigationTitle("Unlock your mail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Later") { dismiss() } }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .data, .plainText, .item]) { result in
                guard case .success(let url) = result else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url), let string = String(data: data, encoding: .utf8) {
                    text = string
                    save(fromClipboard: false)
                } else {
                    error = "Couldn't read that file."
                }
            }
        }
    }

    private func save(fromClipboard: Bool) {
        do {
            try model.importKey(text)
            text = ""
            if fromClipboard { UIPasteboard.general.string = "" }
            Haptics.success()
            model.toast = Toast(text: fromClipboard ? "Key saved. Clipboard cleared." : "Key saved to Keychain", systemImage: "key.fill")
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
