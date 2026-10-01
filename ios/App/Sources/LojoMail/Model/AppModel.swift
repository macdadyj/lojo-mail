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
    var lastBackgroundCheck: Date?

    var sendTestMode: Bool { didSet { UserDefaults.standard.set(sendTestMode, forKey: "sendTestMode") } }
    var notificationsEnabled: Bool { didSet { UserDefaults.standard.set(notificationsEnabled, forKey: "notificationsEnabled") } }
    var notificationSubjects: Bool { didSet { UserDefaults.standard.set(notificationSubjects, forKey: "notificationSubjects") } }
    var appLockEnabled: Bool { didSet { UserDefaults.standard.set(appLockEnabled, forKey: "appLockEnabled") } }

    let launch = LaunchOptions.current
    let notificationRouter = NotificationRouter()
    private let urlSession = APIClient.makeSession()
    private let pathMonitor = NWPathMonitor()
    private var pollTask: Task<Void, Never>?
    private var renewing: Task<Bool, Never>?

    init() {
        let defaults = UserDefaults.standard
        defaults.register(defaults: ["sendTestMode": true, "notificationsEnabled": false, "notificationSubjects": false, "appLockEnabled": false])
        sendTestMode = defaults.bool(forKey: "sendTestMode")
        notificationsEnabled = defaults.bool(forKey: "notificationsEnabled")
        notificationSubjects = defaults.bool(forKey: "notificationSubjects")
        appLockEnabled = defaults.bool(forKey: "appLockEnabled")
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
        let imported = Provisioning.importPending()
        if let url = imported.apiURL { setAPIBase(url) }
        if let session = imported.session { store(session: session) }
        if let key = imported.key { store(key: key) }

        if let data = Keychain.get(.session), let stored = try? JSONDecoder().decode(Session.self, from: data) {
            session = stored
        }
        if let data = Keychain.get(.envelopeKey), let text = String(data: data, encoding: .utf8) {
            key = try? Envelope.PrivateKey(pasted: text)
        }
        keepsPassphrase = Keychain.get(.passphrase) != nil
        if launch.previewSignedOut {
            phase = .signedOut
            return
        }
        if session?.isValid() == true {
            phase = .ready
        } else if keepsPassphrase {
            phase = .ready
            Task { if await renewSession() == false { expire() } }
        } else {
            phase = .signedOut
            if session != nil { signOutReason = "Your session ended. Sign in again." }
        }
        if let folder = launch.folder, folders[folder] == nil { folders[folder] = FolderState() }
    }

    func signIn(passphrase: String, keep: Bool) async throws {
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
        Keychain.delete(.passphrase)
        keepsPassphrase = false
    }

    private func store(session: Session) {
        self.session = session
        if let data = try? JSONEncoder().encode(session) { Keychain.set(data, for: .session) }
    }

    func store(key: Envelope.PrivateKey) {
        guard let data = try? key.encoded() else { return }
        Keychain.set(data, for: .envelopeKey)
        self.key = key
        bodies = bodies.filter { if case .opened = $0.value { return true } else { return false } }
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
        store(key: key)
    }

    func importKey(fileAt url: URL) throws {
        let key = try readKeyFile(url)
        try checkBelongsToMailbox(key)
        store(key: key)
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
        store(key: incoming.key)
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
        Keychain.delete(.envelopeKey)
        key = nil
        bodies = [:]
    }

    func signOut(removeKey alsoKey: Bool) {
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

    private func expire() {
        Keychain.delete(.session)
        session = nil
        signOutReason = "Your session ended. Sign in again."
        phase = .signedOut
    }

    /// Signs in again with the stored passphrase (only if Jon chose "Keep me signed in").
    private func renewSession() async -> Bool {
        if let renewing { return await renewing.value }
        guard let data = Keychain.get(.passphrase), let passphrase = String(data: data, encoding: .utf8) else { return false }
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
        return ok
    }

    /// Every API call goes through here: an expired session is renewed once if possible, otherwise Jon is signed out.
    func call<T: Sendable>(_ operation: @Sendable (APIClient) async throws -> T) async throws -> T {
        if session?.isValid(margin: 300) != true, keepsPassphrase { _ = await renewSession() }
        do {
            return try await operation(api)
        } catch APIError.unauthorized {
            if await renewSession() { return try await operation(api) }
            expire()
            throw APIError.unauthorized
        }
    }

    func setAPIBase(_ url: URL) {
        apiBase = url
        UserDefaults.standard.set(url.absoluteString, forKey: "apiBase")
    }

    // MARK: Folders

    func state(_ folder: Folder) -> FolderState { folders[folder] ?? FolderState() }

    func refresh(_ folder: Folder) async {
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
        async let inbox: Void = refresh(.inbox)
        async let drafts: Void = refreshDrafts()
        async let rules: Void = refreshRules()
        _ = await (inbox, drafts, rules)
        if serverSettings == nil { serverSettings = try? await call { try await $0.settings() } }
        if let mailbox = serverSettings?.mailbox { self.mailbox = mailbox }
    }

    /// Foreground poll every 60 s while the app is active.
    func startPolling() {
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

    /// Background app refresh: metadata only, since the envelope key is not readable while the phone is locked.
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

    /// Decrypts an attachment on the phone and writes it to a temporary, file-protected location for Quick Look.
    func openAttachment(_ attachment: AttachmentMeta, of message: Message) async throws -> URL {
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
        return try AttachmentFiles.write(bytes, filename: attachment.filename)
    }

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
        }
    }

    func search(_ query: String) async throws -> [Message] {
        try await call { try await $0.search(query) }
    }

    func report(_ error: Error) {
        if case APIError.unauthorized = error { return }
        toast = Toast(text: error.localizedDescription, systemImage: "exclamationmark.triangle.fill")
    }

    // MARK: Drafts

    func refreshDrafts() async {
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
    var reviewCount: Int {
        drafts.filter { $0.draft.status == .pendingApproval || ($0.draft.origin.isBot && $0.draft.status.editable) }.count
    }

    func upsertDraft(_ view: DraftView) {
        if let index = drafts.firstIndex(where: { $0.id == view.id }) {
            drafts[index] = view
        } else {
            drafts.insert(view, at: 0)
        }
    }

    // MARK: Rules

    func refreshRules() async {
        do {
            rules = try await call { try await $0.rules() }
            rulesError = nil
        } catch {
            rulesError = error.localizedDescription
        }
    }

    func setKillSwitch(_ on: Bool) async {
        do {
            let doc = try await call { try await $0.setRuleSwitches(killSwitch: on) }
            rules?.rules = doc
            toast = Toast(text: on ? "Autonomous sending stopped" : "Kill switch released", systemImage: on ? "hand.raised.fill" : "checkmark.circle.fill")
        } catch {
            report(error)
        }
    }

    func setSendKillSwitch(_ on: Bool) async {
        do {
            let doc = try await call { try await $0.setRuleSwitches(sendKillSwitch: on) }
            rules?.rules = doc
            toast = Toast(text: on ? "All sending stopped" : "Sending allowed again", systemImage: on ? "xmark.octagon.fill" : "checkmark.circle.fill")
        } catch {
            report(error)
        }
    }

    func setPaused(_ paused: Bool) async {
        do {
            let doc = try await call { try await $0.setRuleSwitches(paused: paused) }
            rules?.rules = doc
        } catch {
            report(error)
        }
    }

    func disableRule(_ id: String) async {
        do {
            let doc = try await call { try await $0.disableRule(id) }
            rules?.rules = doc
        } catch {
            report(error)
        }
    }
}
