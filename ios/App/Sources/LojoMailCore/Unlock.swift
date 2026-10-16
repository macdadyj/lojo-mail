import Foundation

/// Where a secret lives. The envelope key uses `AfterFirstUnlock` so an app update can still
/// read it. It is not a file in the app sandbox, and it is not `WhenUnlocked` (that class is
/// unreadable while the phone is locked, which the app used to treat as "the key is gone").
public enum KeyAccessibility: String, Equatable, Sendable {
    case afterFirstUnlock = "kSecAttrAccessibleAfterFirstUnlock"
    case afterFirstUnlockThisDeviceOnly = "kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly"
    case whenUnlockedThisDeviceOnly = "kSecAttrAccessibleWhenUnlockedThisDeviceOnly"
}

public enum StoredSecret: String, CaseIterable, Sendable {
    case session
    case passphrase
    case envelopeKey
    /// Explicit test-mode choice. Absent means off.
    case testMode

    public var accessibility: KeyAccessibility {
        switch self {
        case .session, .passphrase, .testMode:
            return .afterFirstUnlockThisDeviceOnly
        case .envelopeKey:
            return .afterFirstUnlock
        }
    }
}

public enum SecretLookup: Equatable, Sendable {
    case found(Data)
    case missing
    case unavailable
}

public enum SecretPresence: Equatable, Sendable {
    case present
    case absent
    case unreadable

    public init(_ lookup: SecretLookup) {
        switch lookup {
        case .found:
            self = .present
        case .missing:
            self = .absent
        case .unavailable:
            self = .unreadable
        }
    }
}

/// In-memory stand-in for the iOS Keychain. Tests use it to simulate lock, update, and relaunch.
public struct MemorySecretStore: Equatable, Sendable {
    public struct Record: Equatable, Sendable {
        public var data: Data
        public var accessibility: KeyAccessibility

        public init(data: Data, accessibility: KeyAccessibility) {
            self.data = data
            self.accessibility = accessibility
        }
    }

    public var items: [String: Record]
    /// The screen is locked. `AfterFirstUnlock` stays readable; `WhenUnlocked` does not.
    public var screenLocked: Bool
    /// False until the device has been unlocked once since boot.
    public var unlockedSinceBoot: Bool

    public init(items: [String: Record] = [:], screenLocked: Bool = false, unlockedSinceBoot: Bool = true) {
        self.items = items
        self.screenLocked = screenLocked
        self.unlockedSinceBoot = unlockedSinceBoot
    }

    public mutating func set(_ data: Data, for secret: StoredSecret) {
        items[secret.rawValue] = Record(data: data, accessibility: secret.accessibility)
    }

    public func get(_ secret: StoredSecret) -> SecretLookup {
        guard let record = items[secret.rawValue] else { return .missing }
        switch record.accessibility {
        case .afterFirstUnlock, .afterFirstUnlockThisDeviceOnly:
            return unlockedSinceBoot ? .found(record.data) : .unavailable
        case .whenUnlockedThisDeviceOnly:
            if !unlockedSinceBoot || screenLocked { return .unavailable }
            return .found(record.data)
        }
    }

    public mutating func delete(_ secret: StoredSecret) {
        items.removeValue(forKey: secret.rawValue)
    }
}

public enum EnvelopeKeyEvent: Equatable, Sendable {
    case loaded(Data)
    /// The keychain could not be read. Keep the key that is already loaded. Do not delete the item.
    case unchanged
    case absent
}

public enum EnvelopeKeyLoad {
    public static func decide(read: SecretLookup) -> EnvelopeKeyEvent {
        switch read {
        case .found(let data):
            return .loaded(data)
        case .unavailable:
            return .unchanged
        case .missing:
            return .absent
        }
    }
}

public enum SessionStep: Equatable, Sendable {
    case ready
    case renew
    case reauthenticate
}

public enum SessionRecovery {
    /// An expired 12-hour session renews when the passphrase is stored (or the keychain is only
    /// temporarily unreadable). Otherwise Jon signs in again. Neither path removes the envelope key.
    public static func step(sessionValid: Bool, passphrase: SecretPresence) -> SessionStep {
        if sessionValid { return .ready }
        switch passphrase {
        case .present, .unreadable:
            return .renew
        case .absent:
            return .reauthenticate
        }
    }

    public static func removesEnvelopeKey(on step: SessionStep) -> Bool {
        switch step {
        case .ready, .renew, .reauthenticate:
            return false
        }
    }
}

public enum TestModeChoice: Equatable, Sendable {
    case explicit(Bool)
    case unset
}

public enum TestModePolicy {
    /// Test mode is on only when Jon turned it on. A missing preference (fresh install, app
    /// container reset, new bundle id) is off. An explicit keychain value wins over UserDefaults,
    /// so a sandbox wipe cannot turn test mode back on.
    public static func isOn(keychain: TestModeChoice, userDefaults: TestModeChoice) -> Bool {
        switch keychain {
        case .explicit(let on):
            return on
        case .unset:
            switch userDefaults {
            case .explicit(let on):
                return on
            case .unset:
                return false
            }
        }
    }
}

public struct UnlockButton: Equatable, Identifiable, Sendable {
    public enum Action: String, CaseIterable, Sendable {
        case chooseFromFiles
        case pasteKey
        case airdrop
        case shareOrOpenIn
        case usbFromSantaComputa
        case saveTypedKey
        case retry
    }

    public var action: Action
    public var title: String
    public var systemImage: String
    public var accessibilityIdentifier: String
    public var id: Action { action }

    public init(action: Action, title: String, systemImage: String, accessibilityIdentifier: String) {
        self.action = action
        self.title = title
        self.systemImage = systemImage
        self.accessibilityIdentifier = accessibilityIdentifier
    }
}

public enum UnlockScreen {
    public static let loadButtons: [UnlockButton] = [
        UnlockButton(action: .chooseFromFiles, title: "Choose from Files…", systemImage: "folder", accessibilityIdentifier: "unlock.files"),
        UnlockButton(action: .pasteKey, title: "Paste key", systemImage: "doc.on.clipboard", accessibilityIdentifier: "unlock.paste"),
        UnlockButton(action: .airdrop, title: "AirDrop", systemImage: "airplane.circle", accessibilityIdentifier: "unlock.airdrop"),
        UnlockButton(action: .shareOrOpenIn, title: "Share or Open in", systemImage: "square.and.arrow.up", accessibilityIdentifier: "unlock.share"),
        UnlockButton(action: .usbFromSantaComputa, title: "USB from Santa Computa", systemImage: "cable.connector", accessibilityIdentifier: "unlock.usb"),
    ]

    public static let saveButton = UnlockButton(
        action: .saveTypedKey,
        title: "Save to Keychain",
        systemImage: "key.fill",
        accessibilityIdentifier: "unlock.save"
    )

    public static let retry = UnlockButton(
        action: .retry,
        title: "Try again",
        systemImage: "arrow.clockwise",
        accessibilityIdentifier: "unlock.retry"
    )

    /// Every option on the unlock screen, each one a button.
    public static var buttons: [UnlockButton] { loadButtons + [saveButton, retry] }

    public static func detail(for action: UnlockButton.Action) -> String {
        switch action {
        case .chooseFromFiles:
            return "Pick envelope.private.jwk from Files."
        case .pasteKey:
            return "Paste the JWK. The clipboard is cleared once it is saved."
        case .airdrop:
            return "AirDrop envelope.private.jwk and choose LOJO Mail, then tap here to import it."
        case .shareOrOpenIn:
            return "Share the file to LOJO Mail, then tap here to import it."
        case .usbFromSantaComputa:
            return "Import the key provision-phone.sh copied over USB."
        case .saveTypedKey:
            return "Save the key typed below into the Keychain."
        case .retry:
            return "Check again for a key."
        }
    }

    public static func missingGuidance(for action: UnlockButton.Action) -> String {
        switch action {
        case .usbFromSantaComputa:
            return USBProvision.missingGuidance
        case .airdrop:
            return "No AirDrop key is waiting. From your Mac, AirDrop envelope.private.jwk to this iPhone and choose LOJO Mail, then tap Try again."
        case .shareOrOpenIn:
            return "No shared key is waiting. In Files or Mail, share envelope.private.jwk and pick LOJO Mail, then tap Try again."
        case .pasteKey:
            return "The clipboard has no key. Copy envelope.private.jwk, then tap Try again."
        case .chooseFromFiles:
            return "Choose envelope.private.jwk in Files, then tap Try again if it does not import."
        case .saveTypedKey:
            return "Paste or type the key in the field, then tap Save to Keychain."
        case .retry:
            return "Nothing new arrived. Tap Try again after the key is on this iPhone."
        }
    }
}

public enum UnlockImportResult: Equatable, Sendable {
    case unlocked
    case missing(String)
    case failed(String)
}

public enum USBProvision {
    public static let keyFileName = "provision-envelope.private.jwk"
    public static let sessionFileName = "provision-session.json"
    public static let apiURLFileName = "provision-api-url.txt"
    public static let fileNames = [sessionFileName, keyFileName, apiURLFileName]

    public static let missingGuidance = "No key from Santa Computa is on this iPhone yet. Plug the phone in, run ios/scripts/provision-phone.sh on Santa Computa, then tap Try again."

    public struct Files: Sendable {
        public var key: Envelope.PrivateKey?
        public var session: Session?
        public var apiURL: URL?
        public var keyFilePresent: Bool
        public var keyError: String?

        public init(key: Envelope.PrivateKey? = nil, session: Session? = nil, apiURL: URL? = nil, keyFilePresent: Bool = false, keyError: String? = nil) {
            self.key = key
            self.session = session
            self.apiURL = apiURL
            self.keyFilePresent = keyFilePresent
            self.keyError = keyError
        }
    }

    public static func outcome(_ files: Files) -> UnlockImportResult {
        if files.key != nil { return .unlocked }
        if files.keyFilePresent {
            return .failed(files.keyError ?? "That provisioned file isn't an envelope key.")
        }
        return .missing(missingGuidance)
    }

    /// Reads `provision-*` files and deletes them. The durable copy is the Keychain, not Documents.
    public static func consume(directory: URL, fileManager: FileManager = .default) -> Files {
        var files = Files()
        let keyURL = directory.appendingPathComponent(keyFileName)
        if fileManager.fileExists(atPath: keyURL.path) {
            files.keyFilePresent = true
            if let text = try? String(contentsOf: keyURL, encoding: .utf8) {
                do {
                    files.key = try KeyFile.parse(text)
                } catch {
                    files.keyError = (error as? LocalizedError)?.errorDescription ?? "That provisioned file isn't an envelope key."
                }
            } else {
                files.keyError = KeyFile.Failure.notText.errorDescription
            }
        }
        let sessionURL = directory.appendingPathComponent(sessionFileName)
        if let data = try? Data(contentsOf: sessionURL),
           let session = try? JSONDecoder().decode(Session.self, from: data),
           session.isValid() {
            files.session = session
        }
        let apiURLFile = directory.appendingPathComponent(apiURLFileName)
        if let text = try? String(contentsOf: apiURLFile, encoding: .utf8) {
            files.apiURL = APIClient.validatedBaseURL(text)
        }
        for name in fileNames {
            let url = directory.appendingPathComponent(name)
            if fileManager.fileExists(atPath: url.path) {
                try? fileManager.removeItem(at: url)
            }
        }
        return files
    }
}

public enum InboxDrop {
    /// The first regular file in Documents/Inbox (AirDrop and "Open in" land there).
    public static func firstKeyFile(in directory: URL, fileManager: FileManager = .default) -> URL? {
        guard let names = try? fileManager.contentsOfDirectory(atPath: directory.path) else { return nil }
        for name in names.sorted() {
            if name.hasPrefix(".") { continue }
            let url = directory.appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue else { continue }
            return url
        }
        return nil
    }
}

public enum LaunchSideEffects {
    /// Screenshot hooks (`LOJO_SCREEN`, sample attachments) and UI tests choose a screen.
    /// None of them enable test mode or delete the envelope key.
    public static func enablesTestMode(screen: String?) -> Bool { false }

    public static func discardsEnvelopeKey(screen: String?) -> Bool { false }

    public static func writesEnvelopeKey(uiTest: Bool) -> Bool { false }

    public static func persistsUITestSession(uiTest: Bool) -> Bool { false }
}

/// The line Settings shows, so a tester can tell which TestFlight build is installed.
public enum AppBuild {
    public static func label(info: [String: Any]?) -> String {
        let version = resolved(info?["CFBundleShortVersionString"] as? String, fallback: "0.1")
        let build = resolved(info?["CFBundleVersion"] as? String, fallback: "2")
        return "Version \(version) (build \(build))"
    }

    private static func resolved(_ raw: String?, fallback: String) -> String {
        guard let raw else { return fallback }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else { return fallback }
        return trimmed
    }
}

/// Primary chrome. Review is the approval queue, not a tab — Jon already approves from Compose.
public enum AppChrome {
    public static let tabs = ["Mail", "Rules", "Settings"]
    public static let reviewTitle = "Approval queue"
    public static let reviewExplanation = "Drafts from SI, assistants, mail rules, and your desktop client wait here. Nothing they write is sent until you open one and tap Approve and send. Your own saved drafts show up here too."
    public static let reviewMenuTitle = "Approval queue"

    public static func reviewMenuLabel(waiting: Int) -> String {
        waiting == 0 ? reviewMenuTitle : "\(reviewMenuTitle) (\(waiting))"
    }

    public static func reviewBanner(waiting: Int) -> String {
        switch waiting {
        case 1:
            return "1 draft waiting in the approval queue"
        default:
            return "\(waiting) drafts waiting in the approval queue"
        }
    }

    public static func reviewSettingsDetail(waiting: Int) -> String {
        waiting == 0
            ? "No drafts waiting. SI, assistants, and rules leave mail here instead of sending it."
            : "\(waiting) waiting for your approval before anything is sent."
    }
}

/// Which drafts belong in the count on Mail and Settings. Sending still happens on the draft.
public enum ReviewQueue {
    public static func needsAttention(_ draft: Draft) -> Bool {
        draft.status == .pendingApproval || (draft.origin.isBot && draft.status.editable)
    }

    public static func count(_ drafts: [Draft]) -> Int {
        drafts.reduce(into: 0) { total, draft in
            if needsAttention(draft) { total += 1 }
        }
    }
}

/// Keychain plus the sandbox files an update may drop. Session expiry, update, and relaunch keep the envelope key.
public struct KeySurvival: Equatable, Sendable {
    public var store: MemorySecretStore
    public var sandbox: [String: Data]

    public init(store: MemorySecretStore = MemorySecretStore(), sandbox: [String: Data] = [:]) {
        self.store = store
        self.sandbox = sandbox
    }

    public static func install(key: Data, session: Data) -> KeySurvival {
        var life = KeySurvival()
        life.store.set(key, for: .envelopeKey)
        life.store.set(session, for: .session)
        life.sandbox[USBProvision.keyFileName] = key
        return life
    }

    public func expireSession() -> KeySurvival {
        var next = self
        next.store.delete(.session)
        return next
    }

    /// An update of the same installation keeps the keychain and can drop sandbox files.
    public func appUpdate() -> KeySurvival {
        var next = self
        next.sandbox = [:]
        return next
    }

    public func relaunch(screenLocked: Bool) -> SecretLookup {
        var copy = store
        copy.screenLocked = screenLocked
        return copy.get(.envelopeKey)
    }
}
