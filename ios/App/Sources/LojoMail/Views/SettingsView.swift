import LojoMailCore
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var showKeySetup = false
    @State private var confirmRemoveKey = false
    @State private var confirmSignOut = false
    @State private var notificationStatus = "Checking…"
    @State private var apiText = ""
    @State private var apiError: String?
    @State private var trustedText = ""
    @State private var trustedError: String?
    @State private var siFilter: SiFilterRequest?
    @Environment(\.openReview) private var openReview

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Mailbox", value: model.mailbox)
                    Button {
                        openReview()
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: "tray.full")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Theme.accent)
                                .frame(width: 28, alignment: .center)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(AppChrome.reviewTitle)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Text(AppChrome.reviewSettingsDetail(waiting: model.reviewCount))
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                                .padding(.top, 4)
                                .accessibilityHidden(true)
                        }
                    }
                    .accessibilityIdentifier("settings.approval-queue")
                    if let expiry = model.session?.expiry {
                        LabeledContent("Session until", value: expiry.formatted(date: .abbreviated, time: .shortened))
                    }
                    if model.keepsPassphrase {
                        Button("Stop keeping me signed in") { model.forgetPassphrase() }
                    } else {
                        Text("You'll sign in again when the 12-hour session ends. Choose \"Keep me signed in\" at sign-in to renew it automatically.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    if let key = model.key {
                        LabeledContent("Envelope key") {
                            if model.keyMismatch {
                                Label("Wrong mailbox", systemImage: "exclamationmark.lock.fill").foregroundStyle(.red)
                            } else if model.serverSettings?.envelopeKeyFingerprint != nil {
                                Label("Matches server", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                            } else {
                                Label("Loaded", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                            }
                        }
                        LabeledContent("Fingerprint", value: key.fingerprint).font(.footnote.monospaced())
                        Button("Replace key…") { showKeySetup = true }
                        Button("Remove key from this iPhone", role: .destructive) { confirmRemoveKey = true }
                    } else {
                        LabeledContent("Envelope key") {
                            Label("Not loaded", systemImage: "lock.fill").foregroundStyle(.orange)
                        }
                        Button("Load envelope key…") { showKeySetup = true }
                    }
                } header: {
                    Text("Decryption")
                } footer: {
                    Text("Bodies and attachments are opened on this iPhone with this key. It is kept in the Keychain (AfterFirstUnlock) so an app update does not drop it, and it is not stored in the app's files.\n\nTo load or replace it: tap the button above. Files, paste, AirDrop, share, and USB from Santa Computa are buttons.")
                }

                Section {
                    Toggle("Test mode", isOn: $model.sendTestMode)
                        .accessibilityIdentifier("testmode.toggle")
                    if model.sendTestMode {
                        Button("Turn off test mode") { model.sendTestMode = false }
                            .accessibilityIdentifier("testmode.off")
                    }
                } header: {
                    Text("Sending")
                } footer: {
                    Text(model.sendTestMode
                        ? "Test mode is on because you turned it on. Sending is limited to \(AppModel.testAddress). Tap Turn off test mode to leave it. The app will not turn it on by itself."
                        : "Test mode is off. It stays off until you turn it on here. Approve and send can reach any recipient, and every send still asks you to confirm.")
                }

                Section {
                    Toggle("New mail notifications", isOn: Binding(get: { model.notificationsEnabled }, set: { on in
                        if on {
                            Task {
                                model.notificationsEnabled = await Notifier.requestPermission()
                                await refreshNotificationStatus()
                            }
                        } else {
                            model.notificationsEnabled = false
                        }
                    }))
                    Toggle("Show subject", isOn: $model.notificationSubjects).disabled(!model.notificationsEnabled)
                    LabeledContent("Permission", value: notificationStatus)
                    LabeledContent("Background refresh", value: backgroundRefreshStatus)
                    if let last = model.lastBackgroundCheck {
                        LabeledContent("Last background check", value: last.formatted(date: .abbreviated, time: .shortened))
                    }
                } header: {
                    Text("Freshness")
                } footer: {
                    Text("While open, the app checks every minute. In the background iOS runs a refresh when it chooses (often every 15 minutes to a few hours, less when the battery is low) and the app posts a local notification. There is no instant push: Apple Push Notifications need a paid developer account. Notifications show the sender and, if you allow it, the subject; never the body.")
                }

                Section {
                    Toggle("Require Face ID", isOn: $model.appLockEnabled)
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("Locks the app when it goes to the background and hides its content in the app switcher.")
                }

                Section {
                    TextEditor(text: $trustedText)
                        .font(.footnote.monospaced())
                        .frame(minHeight: 96)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("Trusted link domains")
                    if trustedText != model.trustedLinkDomains.joined(separator: "\n") {
                        Button("Save domains") { saveTrusted() }
                    }
                    Button("Use the built-in list") {
                        trustedText = MessageLinks.defaultTrustedDomains.joined(separator: "\n")
                        saveTrusted()
                    }
                    if let trustedError { Text(trustedError).font(.footnote).foregroundStyle(.red) }
                } header: {
                    Text("Links")
                } footer: {
                    Text("A message from one of these domains, or a subdomain, opens its links when you tap them, if the sender passed DMARC and wasn't marked spam or virus. Every other link asks first. Remote images are never loaded. Same list as the web app, kept on this iPhone.")
                }

                Section {
                    TextField("API URL", text: $apiText)
                        .font(.footnote.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .submitLabel(.done)
                        .onSubmit { applyAPI() }
                    if apiText != model.apiBase.absoluteString {
                        Button("Use this server") { applyAPI() }
                    }
                    if let apiError { Text(apiError).font(.footnote).foregroundStyle(.red) }
                    if let settings = model.serverSettings {
                        LabeledContent("Model", value: settings.llmProvider)
                        LabeledContent("SI budget today", value: "\(settings.budgetUsed.formatted()) / \(settings.dailyTokenBudget.formatted()) tokens")
                        LabeledContent("Attachments from the app") {
                            Text(settings.draftAttachments.map { "Up to \($0.maxFiles ?? AttachmentBudget.defaultMaxFiles) files, \(ByteSize.format($0.maxMessageBytes)) per message" } ?? "Not supported by this server")
                                .foregroundStyle(settings.draftAttachments == nil ? .orange : .secondary)
                        }
                        if settings.dev { LabeledContent("Server", value: "local dev") }
                    }
                } header: {
                    Text("Server")
                } footer: {
                    Text("HTTPS only. The web app lives at app.cyberphysical.us.")
                }

                Section {
                    Toggle("Stop SI filters", isOn: Binding(
                        get: { model.rules?.rules.siKillSwitch == true },
                        set: { on in Task { await model.setSiKillSwitch(on) } }
                    ))
                    .accessibilityIdentifier("si.kill-switch")
                    Button("Filter the inbox with SI") {
                        siFilter = SiFilterRequest(messageIds: [], folder: Folder.inbox.rawValue, texts: model.siTexts(for: model.state(.inbox).messages))
                    }
                    .accessibilityIdentifier("si.filter.settings")
                    NavigationLink("Blocked") { BlockedSendersView() }
                    NavigationLink("Saved SI filters") { SiRulesView() }
                } header: {
                    Text("SI")
                } footer: {
                    Text("Filter with SI proposes a label, junk, Trash, or a block. Trash is kept and can be restored. Saved filters run on new mail until you turn this switch on. Unblock a sender from Blocked. Reply with SI only writes a draft.")
                }

                Section("About") {
                    Text(AppBuild.label(info: Bundle.main.infoDictionary))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("settings.build")
                    Link("Open the web app", destination: URL(string: "https://app.cyberphysical.us")!)
                }

                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showKeySetup) { KeySetupView() }
            .sheet(item: $siFilter) { request in
                NavigationStack { SiFilterView(request: request) }
            }
            .task { await model.refreshRules() }
            .onAppear { if model.launch.screen == .key { showKeySetup = true } }
            .confirmationDialog("Remove the envelope key?", isPresented: $confirmRemoveKey, titleVisibility: .visible) {
                Button("Remove key", role: .destructive) { model.removeKey() }
            } message: {
                Text("Mail stays on the server, sealed. You'll need to paste the key again to read it here.")
            }
            .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out, keep the key", role: .destructive) { model.signOut(removeKey: false) }
                Button("Sign out and remove the key", role: .destructive) { model.signOut(removeKey: true) }
            } message: {
                Text("Removes the session, any stored passphrase and the cached mail list from this iPhone.")
            }
            .task {
                apiText = model.apiBase.absoluteString
                trustedText = model.trustedLinkDomains.joined(separator: "\n")
                await refreshNotificationStatus()
                await model.refreshSettings()
            }
        }
    }

    private var backgroundRefreshStatus: String {
        switch UIApplication.shared.backgroundRefreshStatus {
        case .available: "On"
        case .denied: "Off in iOS Settings"
        case .restricted: "Restricted"
        @unknown default: "Unknown"
        }
    }

    private func refreshNotificationStatus() async {
        notificationStatus = switch await Notifier.authorizationStatus() {
        case .authorized: "Allowed"
        case .denied: "Denied in iOS Settings"
        case .notDetermined: "Not asked yet"
        case .provisional: "Quiet"
        case .ephemeral: "Temporary"
        @unknown default: "Unknown"
        }
    }

    private func saveTrusted() {
        let parsed = MessageLinks.parseTrustedDomainList(trustedText)
        if let error = parsed.error {
            trustedError = error
            return
        }
        trustedError = nil
        model.trustedLinkDomains = parsed.domains
        trustedText = parsed.domains.joined(separator: "\n")
    }

    private func applyAPI() {
        guard let url = APIClient.validatedBaseURL(apiText) else {
            apiError = "Must be an https URL."
            return
        }
        apiError = nil
        model.setAPIBase(url)
    }
}
