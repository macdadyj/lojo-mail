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

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Mailbox", value: model.mailbox)
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
                    Text("Bodies and attachments are opened on this iPhone with this key. It is kept in the Keychain for this device only and is never sent anywhere.\n\nTo load or replace it: tap the button above and choose envelope.private.jwk from Files or paste it; or AirDrop or share the file to this iPhone and pick LOJO Mail.")
                }

                Section {
                    Toggle("Test mode", isOn: $model.sendTestMode)
                } header: {
                    Text("Sending")
                } footer: {
                    Text(model.sendTestMode
                        ? "Sending is limited to \(AppModel.testAddress). Everything else can still be saved to the approval queue."
                        : "Approve and send can reach any recipient. Every send still asks you to confirm.")
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
                    TextField("API URL", text: $apiText)
                        .font(.footnote.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .onSubmit { applyAPI() }
                    if let apiError { Text(apiError).font(.footnote).foregroundStyle(.red) }
                    if let settings = model.serverSettings {
                        LabeledContent("AI provider", value: settings.llmProvider)
                        LabeledContent("AI budget today", value: "\(settings.budgetUsed.formatted()) / \(settings.dailyTokenBudget.formatted()) tokens")
                        if settings.dev { LabeledContent("Server", value: "local dev") }
                    }
                } header: {
                    Text("Server")
                } footer: {
                    Text("HTTPS only. The web app lives at app.cyberphysical.us.")
                }

                Section("About") {
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?")
                    Link("Open the web app", destination: URL(string: "https://app.cyberphysical.us")!)
                }

                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showKeySetup) { KeySetupView() }
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
                await refreshNotificationStatus()
                if model.serverSettings == nil { model.serverSettings = try? await model.call { try await $0.settings() } }
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

    private func applyAPI() {
        guard let url = APIClient.validatedBaseURL(apiText) else {
            apiError = "Must be an https URL."
            return
        }
        apiError = nil
        model.setAPIBase(url)
    }
}
