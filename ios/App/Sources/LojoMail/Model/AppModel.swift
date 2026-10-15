import Foundation
import LojoMailCore
import Network
import Observation
import SwiftUI

struct FolderState {
    var messages: [Message] = []
    var loading = false
    var error: String?
    var updatedAt: Date?
    var fromCache = false

    var conversations: [Conversation] { Conversation.group(messages) }
    var unreadCount: Int { Set(messages.filter(\.unread).map(\.threadId)).count }
}

struct Toast: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var systemImage: String = "checkmark.circle.fill"
    var undo: UndoAction?

    static func == (lhs: Toast, rhs: Toast) -> Bool { lhs.id == rhs.id }
}

enum UndoAction {
    case restore([String])
    case moveBack([String], Folder)
    /// One Filter with SI apply, or an unblock. The server puts mail and rules back.
    case siChange(String)
}

enum BodyState: Equatable {
    case opened(SealedBody)
    case locked
    case failed(String)
}

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case launching, signedOut, ready }

    static let testAddress = "lojo-test@cyberphysical.us"

    var phase: Phase = .launching
    var signOutReason: String?
    private(set) var session: Session?
    private(set) var key: Envelope.PrivateKey?
    private(set) var keepsPassphrase = false
    var apiBase: URL
    var mailbox = "lojo@cyberphysical.us"

    var folders: [Folder: FolderState] = [:]
    var bodies: [String: BodyState] = [:]
    var drafts: [DraftView] = []
    var draftsLoading = false
    var draftsError: String?
    var rules: RulesState?
    var rulesError: String?
    var serverSettings: ServerSettings?
    var online = true
    var toast: Toast?
    var openThreadRequest: String?
    /// Opens the approval queue (the old Review tab) from Mail or Settings.
    var openReviewRequest = false
    var lastBackgroundCheck: Date?

    /// Off unless Jon turns it on. The choice is stored in UserDefaults and the Keychain.
    /// A missing value is off: the old registered default of `true` turned test mode on by itself
    /// whenever the app container was new (reinstall, or a new `XTL-<team>` bundle id).
    var sendTestMode: Bool {
        didSet {
            if LaunchOptions.current.uiTest { return }
            UserDefaults.standard.set(sendTestMode, forKey: Self.testModeDefaultsKey)
            _ = Keychain.set(Data([sendTestMode ? 1 : 0]), for: .testMode)
        }
    }

    /// Set when the envelope key could not be read (phone locked). Not the same as "no key".
    var keyReadUnavailable = false

    private static let testModeDefaultsKey = "sendTestMode"
    var notificationsEnabled: Bool { didSet { UserDefaults.standard.set(notificationsEnabled, forKey: "notificationsEnabled") } }
    var notificationSubjects: Bool { didSet { UserDefaults.standard.set(notificationSubjects, forKey: "notificationSubjects") } }
    var appLockEnabled: Bool { didSet { UserDefaults.standard.set(appLockEnabled, forKey: "appLockEnabled") } }
    /// Senders whose links open on a tap (when the sender also passed DMARC). Same default list as the web app.
    var trustedLinkDomains: [String] { didSet { UserDefaults.standard.set(trustedLinkDomains, forKey: "trustedLinkDomains") } }

    let launch = LaunchOptions.current
    let notificationRouter = NotificationRouter()
    private let urlSession = APIClient.makeSession()
    private let pathMonitor = NWPathMonitor()
    private var pollTask: Task<Void, Never>?
    private var renewing: Task<Bool, Never>?

    init() {
        let defaults = UserDefaults.standard
        defaults.register(defaults: ["notificationsEnabled": false, "notificationSubjects": false, "appLockEnabled": false])
        let defaultsChoice: TestModeChoice = defaults.object(forKey: Self.testModeDefaultsKey) == nil
            ? .unset
            : .explicit(defaults.bool(forKey: Self.testModeDefaultsKey))
        let keychainChoice: TestModeChoice
        switch Keychain.lookup(.testMode) {
        case .found(let data):
            keychainChoice = .explicit(data.first == 1)
        case .missing, .unavailable:
            keychainChoice = .unset
        }
        sendTestMode = TestModePolicy.isOn(keychain: keychainChoice, userDefaults: defaultsChoice)
        if !LaunchOptions.current.uiTest,
           case .missing = Keychain.lookup(.testMode),
           case .explicit(let on) = defaultsChoice {
            _ = Keychain.set(Data([on ? 1 : 0]), for: .testMode)
        }
        notificationsEnabled = defaults.bool(forKey: "notificationsEnabled")
        notificationSubjects = defaults.bool(forKey: "notificationSubjects")
        appLockEnabled = defaults.bool(forKey: "appLockEnabled")
        trustedLinkDomains = (defaults.stringArray(forKey: "trustedLinkDomains") ?? MessageLinks.defaultTrustedDomains).compactMap(MessageLinks.normalizeDomain)
        apiBase = defaults.string(forKey: "apiBase").flatMap(APIClient.validatedBaseURL) ?? APIClient.defaultBaseURL
        lastBackgroundCheck = defaults.object(forKey: "lastBackgroundCheck") as? Date
        for folder in Folder.allCases {
            if let snapshot = MetadataCache.load(folder) {
                folders[folder] = FolderState(messages: snapshot.messages, updatedAt: snapshot.savedAt, fromCache: true)
            }
        }
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in self?.online = satisfied }
        }
        pathMonitor.start(queue: DispatchQueue(label: "lojo.mail.path"))
        notificationRouter.onOpenThread = { [weak self] threadId in self?.openThreadRequest = threadId }
    }

    // MARK: Session and key

    var api: APIClient { APIClient(baseURL: apiBase, token: session?.sessionToken, session: urlSession) }

    func start() {
        AttachmentFiles.purge()
        if launch.uiTest {
            applyUITestFixtures()
            return
        }
        _ = applyProvisioned(Provisioning.importPending())
        reloadSecrets(initial: true)
    }

    /// In-memory mailbox for UI tests. Does not write the session, passphrase, test-mode flag, or envelope key.
    private func applyUITestFixtures() {
        guard !UITestFixtures.enablesTestMode,
              !UITestFixtures.writesEnvelopeKey,
              !UITestFixtures.deletesEnvelopeKey,
              !UITestFixtures.persistsSession,
              !LaunchSideEffects.enablesTestMode(screen: launch.screen?.rawValue),
              !LaunchSideEffects.discardsEnvelopeKey(screen: launch.screen?.rawValue),
              !LaunchSideEffects.writesEnvelopeKey(uiTest: true),
              !LaunchSideEffects.persistsUITestSession(uiTest: true)
        else { return }
        session = UITestFixtures.session()
        mailbox = UITestFixtures.mailbox
        if let settings = try? UITestFixtures.settings() { serverSettings = settings }
        if let inbox = try? UITestFixtures.inbox() {
            folders[.inbox] = FolderState(messages: inbox, updatedAt: Date())
            for message in inbox {
                bodies[message.id] = .opened(UITestFixtures.body(for: message))
            }
        }
        if let sent = try? UITestFixtures.sent() {
            folders[.sent] = FolderState(messages: sent, updatedAt: Date())
        }
        if let trash = try? UITestFixtures.trash() {
            folders[.trash] = FolderState(messages: trash, updatedAt: Date())
        }
        for folder in [Folder.drafts, .spam, .archive] where folders[folder] == nil {
            folders[folder] = FolderState(messages: [], updatedAt: Date())
        }
        drafts = (try? UITestFixtures.drafts()) ?? []
        rules = try? UITestFixtures.rules()
        if launch.previewSignedOut {
            phase = .signedOut
            return
        }
        phase = .ready
        switch launch.screen {
        case .review, .draft:
            openReviewRequest = true
        case .thread, .attachment:
            openThreadRequest = launch.thread ?? UITestFixtures.threadId
        default:
            break
        }
    }

    /// Foreground: import a USB drop that arrived while the app was open, and re-read the keychain.
    /// A locked read does not clear the envelope key.
    func restoreAfterForeground() {
        if launch.uiTest { return }
        _ = applyProvisioned(Provisioning.importPending())
        reloadSecrets(initial: false)
    }

    private func reloadSecrets(initial: Bool) {
        switch EnvelopeKeyLoad.decide(read: Keychain.lookup(.envelopeKey)) {
        case .loaded(let data):
            if let text = String(data: data, encoding: .utf8), let parsed = try? Envelope.PrivateKey(pasted: text) {
                key = parsed
                _ = Keychain.set(data, for: .envelopeKey)
            }
            keyReadUnavailable = false
        case .unchanged:
            keyReadUnavailable = key == nil
        case .absent:
            if initial { key = nil }
            keyReadUnavailable = false
        }
        if session == nil, case .found(let data) = Keychain.lookup(.session),
           let stored = try? JSONDecoder().decode(Session.self, from: data) {
            session = stored
        }
        switch Keychain.lookup(.passphrase) {
        case .found:
            keepsPassphrase = true
        case .missing:
            if initial { keepsPassphrase = false }
        case .unavailable:
            break
        }
        if case .found(let flag) = Keychain.lookup(.testMode) {
            let on = flag.first == 1
            if sendTestMode != on { sendTestMode = on }
        }
        // Screenshot launch only. It does not delete the key or turn on test mode.
        if launch.previewSignedOut {
            phase = .signedOut
            return
        }
        switch SessionRecovery.step(sessionValid: session?.isValid() == true, passphrase: SecretPresence(Keychain.lookup(.passphrase))) {
        case .ready:
            phase = .ready
        case .renew:
            phase = .ready
            Task {
                switch await renewSession() {
                case .renewed:
                    break
                case .cannot:
                    expire()
                case .unreadable:
                    break
                }
            }
        case .reauthenticate:
            phase = .signedOut
            if session != nil {
                signOutReason = "Your session ended. Sign in again. Your envelope key stays in the Keychain."
            }
        }
        if let folder = launch.folder, folders[folder] == nil { folders[folder] = FolderState() }
    }

    @discardableResult
    func applyProvisioned(_ files: USBProvision.Files) -> UnlockImportResult {
        if let url = files.apiURL { setAPIBase(url) }
        if let session = files.session { store(session: session) }
        switch USBProvision.outcome(files) {
        case .unlocked:
            guard let key = files.key else { return .missing(USBProvision.missingGuidance) }
            do {
                try checkBelongsToMailbox(key)
                guard store(key: key) else { return .failed("Couldn't save the key to the Keychain. Nothing already stored was removed.") }
                return .unlocked
            } catch {
                return .failed(error.localizedDescription)
            }
        case .missing(let guidance):
            return .missing(guidance)
        case .failed(let message):
            return .failed(message)
        }
    }

    func importProvisionedUSB() -> UnlockImportResult {
        applyProvisioned(Provisioning.importPending())
    }

    func importSharedKey(action: UnlockButton.Action) -> UnlockImportResult {
        guard let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return .missing(UnlockScreen.missingGuidance(for: action))
        }
        let inbox = docs.appendingPathComponent("Inbox", isDirectory: true)
        guard let url = InboxDrop.firstKeyFile(in: inbox) else {
            return .missing(UnlockScreen.missingGuidance(for: action))
        }
        do {
            try importKey(fileAt: url)
            return .unlocked
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    func signIn(passphrase: String, keep: Bool) async throws {
        if launch.uiTest { throw APIError.offline }
        let session = try await APIClient(baseURL: apiBase, session: urlSession).login(passphrase: passphrase)
        store(session: session)
        if keep {
            Keychain.set(Data(passphrase.utf8), for: .passphrase)
        } else {
            Keychain.delete(.passphrase)
        }
        keepsPassphrase = keep
        signOutReason = nil
        phase = .ready
        await refreshAll()
    }

    func forgetPassphrase() {
        if launch.uiTest {
            keepsPassphrase = false
            return
        }
        Keychain.delete(.passphrase)
        keepsPassphrase = false
    }

    private func store(session: Session) {
        self.session = session
        if launch.uiTest { return }
        if let data = try? JSONEncoder().encode(session) { Keychain.set(data, for: .session) }
    }

    @discardableResult
    func store(key: Envelope.PrivateKey) -> Bool {
        if launch.uiTest { return false }
        guard let data = try? key.encoded() else { return false }
        guard Keychain.set(data, for: .envelopeKey) else { return false }
        self.key = key
        bodies = bodies.filter { if case .opened = $0.value { return true } else { return false } }
        return true
    }

    struct KeychainSaveFailure: LocalizedError {
        var errorDescription: String? { "Couldn't save the key to the Keychain. Nothing already stored was removed." }
    }

    struct WrongKey: LocalizedError {
        var errorDescription: String? { "That key isn't the one this mailbox seals mail to. Check you picked envelope.private.jwk for lojo@cyberphysical.us." }
    }

    /// The server publishes which key mail is sealed to; `false` until both sides are known.
    var keyMismatch: Bool {
        guard let key, let published = serverSettings?.envelopeKeyFingerprint else { return false }
        return key.fingerprint != published
    }

    func importKey(_ text: String) throws {
        let key = try KeyFile.parse(text)
        try checkBelongsToMailbox(key)
        guard store(key: key) else { throw KeychainSaveFailure() }
    }

    func importKey(fileAt url: URL) throws {
        let key = try readKeyFile(url)
        try checkBelongsToMailbox(key)
        guard store(key: key) else { throw KeychainSaveFailure() }
    }

    private func checkBelongsToMailbox(_ key: Envelope.PrivateKey) throws {
        if let published = serverSettings?.envelopeKeyFingerprint, key.fingerprint != published { throw WrongKey() }
    }

    /// A key file that arrived through AirDrop, the share sheet or "Open in LOJO Mail", waiting for Jon to confirm.
    struct IncomingKey: Identifiable {
        let id = UUID()
        let key: Envelope.PrivateKey
        let replacesKey: Bool
    }

    var incomingKey: IncomingKey?
    var keyImportError: String?

    /// `onOpenURL`: iOS copied the file into Documents/Inbox. Read it, delete that copy, and ask before storing.
    func receive(openedURL url: URL) {
        guard url.isFileURL else { return }
        do {
            let key = try readKeyFile(url)
            try checkBelongsToMailbox(key)
            if key.fingerprint == self.key?.fingerprint {
                keyImportError = "That key is already on this iPhone."
            } else {
                incomingKey = IncomingKey(key: key, replacesKey: self.key != nil)
            }
        } catch {
            keyImportError = error.localizedDescription
        }
    }

    func accept(_ incoming: IncomingKey) {
        incomingKey = nil
        guard store(key: incoming.key) else {
            keyImportError = KeychainSaveFailure().errorDescription
            return
        }
        toast = Toast(text: "Key saved to Keychain", systemImage: "key.fill")
        if phase == .ready { Task { await refreshAll() } }
    }

    /// Reads at most `KeyFile.maxBytes`, then removes the file if it is a copy inside this app's container.
    private func readKeyFile(_ url: URL) throws -> Envelope.PrivateKey {
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped { url.stopAccessingSecurityScopedResource() }
            Provisioning.removeIfOwned(url)
        }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= KeyFile.maxBytes else { throw KeyFile.Failure.tooLarge }
        guard let data = try? Data(contentsOf: url) else { throw KeyFile.Failure.notText }
        return try KeyFile.read(data)
    }

    func removeKey() {
        if launch.uiTest { return }
        Keychain.delete(.envelopeKey)
        key = nil
        bodies = [:]
    }

    func signOut(removeKey alsoKey: Bool) {
        if launch.uiTest {
            session = nil
            phase = .signedOut
            return
        }
        pollTask?.cancel()
        Keychain.delete(.session)
        Keychain.delete(.passphrase)
        if alsoKey { removeKey() }
        session = nil
        keepsPassphrase = false
        folders = [:]
        bodies = [:]
        drafts = []
        rules = nil
        serverSettings = nil
        MetadataCache.clear()
        AttachmentFiles.purge()
        Notifier.resetSeen()
        signOutReason = nil
        phase = .signedOut
    }

    /// Drops the session only. The envelope key stays in memory and in the Keychain.
    private func expire() {
        let kept = key
        Keychain.delete(.session)
        session = nil
        signOutReason = "Your session ended. Sign in again. Your envelope key stays in the Keychain."
        phase = .signedOut
        key = kept
    }

    private enum RenewResult { case renewed, cannot, unreadable }

    /// Signs in again with the stored passphrase (only if Jon chose "Keep me signed in").
    /// An unreadable keychain is not treated as "no passphrase": the session is not thrown away.
    private func renewSession() async -> RenewResult {
        if let renewing {
            return await renewing.value ? .renewed : .cannot
        }
        let passphraseData: Data
        switch Keychain.lookup(.passphrase) {
        case .found(let data):
            passphraseData = data
        case .missing:
            return .cannot
        case .unavailable:
            return .unreadable
        }
        guard let passphrase = String(data: passphraseData, encoding: .utf8) else { return .cannot }
        let base = apiBase
        let urlSession = urlSession
        let task = Task<Bool, Never> {
            guard let fresh = try? await APIClient(baseURL: base, session: urlSession).login(passphrase: passphrase) else { return false }
            self.store(session: fresh)
            return true
        }
        renewing = task
        let ok = await task.value
        renewing = nil
        return ok ? .renewed : .cannot
    }

    /// Every API call goes through here: an expired session is renewed once if possible.
    /// Failure to renew asks Jon to sign in again and does not remove the envelope key.
    /// A keychain that is only locked does not sign him out.
    func call<T: Sendable>(_ operation: @Sendable (APIClient) async throws -> T) async throws -> T {
        if launch.uiTest { throw APIError.offline }
        if session?.isValid(margin: 300) != true {
            switch await renewSession() {
            case .renewed, .unreadable:
                break
            case .cannot:
                break
            }
        }
        do {
            return try await operation(api)
        } catch APIError.unauthorized {
            switch await renewSession() {
            case .renewed:
                return try await operation(api)
            case .unreadable:
                throw APIError.unauthorized
            case .cannot:
                expire()
                throw APIError.unauthorized
            }
        }
    }

    func setAPIBase(_ url: URL) {
        apiBase = url
        UserDefaults.standard.set(url.absoluteString, forKey: "apiBase")
    }

    // MARK: Folders

    func state(_ folder: Folder) -> FolderState { folders[folder] ?? FolderState() }

    func refresh(_ folder: Folder) async {
        if launch.uiTest { return }
        folders[folder, default: FolderState()].loading = true
        do {
            let messages = try await call { try await $0.folder(folder, limit: 200) }
            folders[folder] = FolderState(messages: messages, updatedAt: Date())
            MetadataCache.save(messages, for: folder)
            if folder == .inbox { await noticeNew(messages) }
        } catch {
            folders[folder, default: FolderState()].loading = false
            folders[folder, default: FolderState()].error = error.localizedDescription
        }
    }

    func refreshAll() async {
        if launch.uiTest { return }
        async let inbox: Void = refresh(.inbox)
        async let drafts: Void = refreshDrafts()
        async let rules: Void = refreshRules()
        _ = await (inbox, drafts, rules)
        await refreshSettings()
    }

    /// Always asks the server: capabilities such as draft attachments change when the server is updated, so a value
    /// from earlier in the session is never trusted to mean "not supported". On failure the last answer is kept.
    @discardableResult
    func refreshSettings() async -> ServerSettings? {
        if launch.uiTest { return serverSettings }
        if let fresh = try? await call({ try await $0.settings() }) {
            serverSettings = fresh
            mailbox = fresh.mailbox
        }
        return serverSettings
    }

    /// Foreground poll every 60 s while the app is active.
    func startPolling() {
        if launch.uiTest { return }
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard let self, !Task.isCancelled, self.phase == .ready, self.online else { continue }
                await self.refresh(.inbox)
                await self.refreshDrafts()
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Background app refresh lists metadata only. The envelope key stays in the Keychain
    /// (`AfterFirstUnlock`) and is not required for this pass.
    func backgroundRefresh() async {
        Notifier.scheduleRefresh()
        guard phase == .ready || keepsPassphrase else { return }
        guard let messages = try? await call({ try await $0.folder(.inbox, limit: 100) }) else { return }
        folders[.inbox] = FolderState(messages: messages, updatedAt: Date())
        MetadataCache.save(messages, for: .inbox)
        await noticeNew(messages)
        lastBackgroundCheck = Date()
        UserDefaults.standard.set(lastBackgroundCheck, forKey: "lastBackgroundCheck")
    }

    private func noticeNew(_ inbox: [Message]) async {
        let fresh = Notifier.newMessages(in: inbox)
        guard notificationsEnabled else { return }
        await Notifier.post(fresh, showSubject: notificationSubjects)
        await Notifier.setBadge(Set(inbox.filter(\.unread).map(\.threadId)).count)
    }

    // MARK: Threads and bodies

    func loadThread(_ id: String) async throws -> [Message] {
        if launch.uiTest {
            let messages = try UITestFixtures.thread(id)
            for message in messages {
                bodies[message.id] = .opened(UITestFixtures.body(for: message))
            }
            return messages
        }
        let response = try await call { try await $0.thread(id) }
        let messages = response.messages.sorted { ($0.sentDate ?? .distantPast) < ($1.sentDate ?? .distantPast) }
        let ids = Set(messages.map(\.id))
        for folder in folders.keys {
            for index in folders[folder]!.messages.indices where ids.contains(folders[folder]!.messages[index].id) {
                folders[folder]!.messages[index].unread = false
            }
        }
        await openBodies(messages)
        return messages
    }

    func openBodies(_ messages: [Message]) async {
        guard let key else {
            for message in messages where message.locked && bodies[message.id] == nil { bodies[message.id] = .locked }
            for message in messages where !message.locked { bodies[message.id] = .opened(SealedBody(text: message.text ?? "")) }
            return
        }
        let api = api
        await withTaskGroup(of: (String, BodyState).self) { group in
            for message in messages {
                if case .opened = bodies[message.id] { continue }
                if !message.locked {
                    bodies[message.id] = .opened(SealedBody(text: message.text ?? ""))
                    continue
                }
                let id = message.id
                group.addTask {
                    do {
                        let blob = try await api.body(id)
                        let body = try Envelope.openJSON(SealedBody.self, blob, with: key, context: Envelope.messageBodyContext(id))
                        return (id, .opened(body))
                    } catch {
                        return (id, .failed(error.localizedDescription))
                    }
                }
            }
            for await (id, state) in group { bodies[id] = state }
        }
    }

    func bodyText(_ message: Message) -> String? {
        guard case .opened(let body) = bodies[message.id] else { return nil }
        if !body.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return body.text }
        if let html = body.html, !html.isEmpty { return MailText.plainText(fromHTML: html) }
        return ""
    }

    /// Text and links of an opened message, as the web app's reader draws them (HTML preferred, nothing remote loaded).
    func bodyParts(_ message: Message) -> [MessagePart]? {
        guard case .opened(let body) = bodies[message.id] else { return nil }
        return MessageLinks.messageParts(text: body.text, html: body.html)
    }

    func linksOpenDirectly(_ message: Message) -> Bool {
        MessageLinks.linksOpenDirectly(message, trusted: trustedLinkDomains)
    }

    /// Decrypts an attachment on the phone and writes it to a temporary, file-protected location for Quick Look.
    func openAttachment(_ attachment: AttachmentMeta, of message: Message) async throws -> URL {
        try AttachmentFiles.write(try await attachmentData(attachment, of: message), filename: attachment.filename)
    }

    /// Decrypted bytes, in memory only (forwarding re-attaches them without writing them to disk).
    func attachmentData(_ attachment: AttachmentMeta, of message: Message) async throws -> Data {
        let payload = try await call { try await $0.attachment(messageId: message.id, attachmentId: attachment.id) }
        let context = Envelope.attachmentContext(message.id, attachment.id)
        let bytes: Data
        switch payload {
        case .plain(let data):
            bytes = data
        case .sealed(let blob):
            guard let key else { throw Envelope.Failure.wrongKey }
            bytes = try Envelope.open(blob, with: key, context: context)
        case .sealedAt(let url):
            guard let key else { throw Envelope.Failure.wrongKey }
            let data = try await api.download(url)
            bytes = try Envelope.open(try Envelope.decodeBlob(data), with: key, context: context)
        }
        return bytes
    }

    /// From the latest `/v1/settings`; `nil` if the server does not accept files on drafts.
    var draftAttachmentSupport: DraftAttachmentSupport? { serverSettings?.draftAttachments }

    // MARK: Mail actions (optimistic, rolled back on failure)

    private func patch(_ ids: Set<String>, _ change: (inout Message) -> Void) {
        for folder in folders.keys {
            for index in folders[folder]!.messages.indices where ids.contains(folders[folder]!.messages[index].id) {
                change(&folders[folder]!.messages[index])
            }
        }
    }

    private func remove(_ ids: Set<String>, from folder: Folder) {
        folders[folder]?.messages.removeAll { ids.contains($0.id) }
    }

    func setUnread(_ messages: [Message], _ unread: Bool) async {
        let ids = Set(messages.map(\.id))
        patch(ids) { $0.unread = unread }
        do {
            for message in messages { try await call { try await $0.setUnread(message.id, unread) } }
        } catch {
            report(error)
            patch(ids) { $0.unread = !unread }
        }
    }

    func setStar(_ messages: [Message], _ starred: Bool) async {
        let targets = starred ? Array(messages.suffix(1)) : messages.filter(\.starred)
        for message in targets {
            var labels = message.labels.filter { $0 != Message.starLabel }
            if starred { labels.append(Message.starLabel) }
            patch([message.id]) { $0.labels = labels }
            do {
                try await call { [labels] in try await $0.setLabels(message.id, labels) }
            } catch {
                report(error)
                patch([message.id]) { $0.labels = message.labels }
            }
        }
    }

    func archive(_ messages: [Message], from folder: Folder) async {
        let ids = Set(messages.map(\.id))
        remove(ids, from: folder)
        do {
            for message in messages { try await call { try await $0.archive(message.id) } }
            toast = Toast(text: messages.count == 1 ? "Archived" : "Archived \(messages.count)", systemImage: "archivebox.fill", undo: .moveBack(Array(ids), folder))
            await refresh(folder)
        } catch {
            report(error)
            await refresh(folder)
        }
    }

    /// Soft delete: the server stamps `trashedAt` and `keepUntil`; Undo or Trash → Restore brings it back.
    func trash(_ messages: [Message], from folder: Folder) async {
        let ids = Set(messages.map(\.id))
        remove(ids, from: folder)
        do {
            for message in messages { try await call { try await $0.move(message.id, to: .trash) } }
            let days = rules?.rules.trashRetentionDays ?? 30
            toast = Toast(text: "Moved to Trash · kept \(days) days", systemImage: "trash.fill", undo: .restore(Array(ids)))
            await refresh(folder)
        } catch {
            report(error)
            await refresh(folder)
        }
    }

    func restore(_ messages: [Message]) async {
        let ids = Set(messages.map(\.id))
        remove(ids, from: .trash)
        do {
            for message in messages { try await call { try await $0.restore(message.id) } }
            toast = Toast(text: "Restored to Inbox", systemImage: "arrow.uturn.backward.circle.fill")
            await refresh(.inbox)
        } catch {
            report(error)
        }
        await refresh(.trash)
    }

    func move(_ messages: [Message], from folder: Folder, to target: Folder) async {
        if target == .trash { return await trash(messages, from: folder) }
        if target == .archive { return await archive(messages, from: folder) }
        let ids = Set(messages.map(\.id))
        remove(ids, from: folder)
        do {
            for message in messages {
                if message.folder == Folder.trash.rawValue && target == .inbox {
                    try await call { try await $0.restore(message.id) }
                } else {
                    try await call { try await $0.move(message.id, to: target) }
                }
            }
            toast = Toast(text: "Moved to \(target.title)", systemImage: target.systemImage, undo: .moveBack(Array(ids), folder))
        } catch {
            report(error)
        }
        await refresh(folder)
        await refresh(target)
    }

    func perform(_ undo: UndoAction) async {
        toast = nil
        switch undo {
        case .restore(let ids):
            for id in ids { try? await call { try await $0.restore(id) } }
            await refresh(.inbox)
            await refresh(.trash)
        case .moveBack(let ids, let folder):
            for id in ids { try? await call { try await $0.move(id, to: folder) } }
            await refresh(folder)
        case .siChange(let changeId):
            do {
                try await call { try await $0.siUndo(changeId) }
                toast = Toast(text: "Undid the SI filter", systemImage: "arrow.uturn.backward.circle.fill")
            } catch {
                report(error)
            }
            for folder in Folder.allCases { await refresh(folder) }
            await refreshRules()
        }
    }

    func search(_ query: String) async throws -> [Message] {
        if launch.uiTest {
            let q = query.lowercased()
            return folders.values.flatMap(\.messages).filter {
                $0.subject.lowercased().contains(q) || $0.from.email.lowercased().contains(q) || ($0.snippet ?? "").lowercased().contains(q)
            }
        }
        try await call { try await $0.search(query) }
    }

    func report(_ error: Error) {
        if case APIError.unauthorized = error { return }
        toast = Toast(text: error.localizedDescription, systemImage: "exclamationmark.triangle.fill")
    }

    // MARK: Drafts

    func refreshDrafts() async {
        if launch.uiTest { draftsLoading = false; draftsError = nil; return }
        draftsLoading = true
        defer { draftsLoading = false }
        do {
            drafts = try await call { try await $0.drafts() }
                .sorted { (ISODate.parse($0.draft.updatedAt) ?? .distantPast) > (ISODate.parse($1.draft.updatedAt) ?? .distantPast) }
            draftsError = nil
        } catch {
            draftsError = error.localizedDescription
        }
    }

    /// Drafts that need Jon: waiting for approval, or written by a bot and not yet handled.
    var reviewCount: Int { ReviewQueue.count(drafts.map(\.draft)) }

    func upsertDraft(_ view: DraftView) {
        if let index = drafts.firstIndex(where: { $0.id == view.id }) {
            drafts[index] = view
        } else {
            drafts.insert(view, at: 0)
        }
    }

    // MARK: Rules

    func refreshRules() async {
        if launch.uiTest { return }
        do {
            rules = try await call { try await $0.rules() }
            rulesError = nil
        } catch {
            rulesError = error.localizedDescription
        }
    }

    func setKillSwitch(_ on: Bool) async {
        if launch.uiTest {
            patchRules { $0.killSwitch = on }
            return
        }
        do {
            let doc = try await call { try await $0.setRuleSwitches(killSwitch: on) }
            rules?.rules = doc
            toast = Toast(text: on ? "Autonomous sending stopped" : "Kill switch released", systemImage: on ? "hand.raised.fill" : "checkmark.circle.fill")
        } catch {
            report(error)
        }
    }

    func setSendKillSwitch(_ on: Bool) async {
        if launch.uiTest {
            patchRules { $0.sendKillSwitch = on }
            return
        }
        do {
            let doc = try await call { try await $0.setRuleSwitches(sendKillSwitch: on) }
            rules?.rules = doc
            toast = Toast(text: on ? "All sending stopped" : "Sending allowed again", systemImage: on ? "xmark.octagon.fill" : "checkmark.circle.fill")
        } catch {
            report(error)
        }
    }

    func setPaused(_ paused: Bool) async {
        if launch.uiTest {
            patchRules { $0.paused = paused }
            return
        }
        do {
            let doc = try await call { try await $0.setRuleSwitches(paused: paused) }
            rules?.rules = doc
        } catch {
            report(error)
        }
    }

    func setSiKillSwitch(_ on: Bool) async {
        if launch.uiTest {
            patchRules { $0.siKillSwitch = on }
            return
        }
        do {
            let doc = try await call { try await $0.setRuleSwitches(siKillSwitch: on) }
            rules?.rules = doc
            toast = Toast(text: on ? "SI filters stopped" : "SI filters on", systemImage: on ? "hand.raised.fill" : "checkmark.circle.fill")
        } catch {
            report(error)
        }
    }

    var mailLabels: [String] {
        let labels = folders.values.flatMap(\.messages).flatMap(\.labels)
        return Array(Set(labels)).filter { $0 != Message.starLabel && $0 != "flagged" }.sorted()
    }

    func siTexts(for messages: [Message]) -> [String: String] {
        var texts: [String: String] = [:]
        for message in messages {
            if let text = bodyText(message), !text.isEmpty { texts[message.id] = String(text.prefix(1500)) }
        }
        return texts
    }

    func disableRule(_ id: String) async {
        if launch.uiTest {
            patchRules { doc in
                if let index = doc.rules.firstIndex(where: { $0.id == id }) {
                    doc.rules[index].enabled = false
                }
            }
            return
        }
        do {
            let doc = try await call { try await $0.disableRule(id) }
            rules?.rules = doc
        } catch {
            report(error)
        }
    }

    private func patchRules(_ change: (inout RulesDocument) -> Void) {
        guard var state = rules else { return }
        change(&state.rules)
        rules = state
    }
}
