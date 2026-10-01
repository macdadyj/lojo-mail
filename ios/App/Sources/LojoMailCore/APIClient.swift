import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum APIError: Error, LocalizedError, Equatable {
    case unauthorized
    case wrongPassphrase
    case rateLimited(retryAfter: Int?)
    case forbidden(String)
    case conflict(String)
    case notFound(String)
    case invalid(String)
    case server(Int, String)
    case offline
    case network(String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .unauthorized: "Your session ended. Sign in again."
        case .wrongPassphrase: "Wrong passphrase."
        case .rateLimited(let after):
            if let after { "Too many failed sign-ins. Try again in \(max(1, after / 60)) min." } else { "Too many requests. Try again shortly." }
        case .forbidden(let message), .conflict(let message), .notFound(let message), .invalid(let message): message
        case .server(let status, let message): "The mail server returned \(status): \(message)"
        case .offline: "You're offline. Showing what was last loaded."
        case .network(let message): "Couldn't reach the mail server (\(message))."
        case .decoding(let what): "The mail server sent something the app didn't understand (\(what))."
        }
    }

    public var isOffline: Bool {
        switch self {
        case .offline, .network: true
        default: false
        }
    }
}

public enum AttachmentPayload: Sendable {
    case sealed(Envelope.Blob)
    case sealedAt(URL)
    case plain(Data)
}

/// Thin client for the lojo-mail `/v1` API. Holds no state beyond the base URL and the bearer token.
public struct APIClient: Sendable {
    public static let defaultBaseURL = URL(string: "https://zp7h9ytl28.execute-api.us-east-1.amazonaws.com")!

    public let baseURL: URL
    public let token: String?
    let session: URLSession

    public init(baseURL: URL = APIClient.defaultBaseURL, token: String? = nil, session: URLSession = APIClient.makeSession()) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    public func with(token: String?) -> APIClient {
        APIClient(baseURL: baseURL, token: token, session: session)
    }

    /// No cookies, no disk cache: message metadata and envelopes stay out of `Library/Caches/`.
    public static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }

    /// Only https, or http on loopback for the local dev server.
    public static func validatedBaseURL(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        if scheme == "https" { return url }
        if scheme == "http" && (host == "127.0.0.1" || host == "localhost") { return url }
        return nil
    }

    // MARK: Session

    public func login(passphrase: String) async throws -> Session {
        do {
            return try await send("POST", "/v1/session/login", json: ["passphrase": passphrase], authorized: false)
        } catch APIError.unauthorized {
            throw APIError.wrongPassphrase
        }
    }

    public func health() async throws -> Bool {
        struct Health: Decodable { var ok: Bool }
        let health: Health = try await send("GET", "/v1/health", authorized: false)
        return health.ok
    }

    public func settings() async throws -> ServerSettings {
        try await send("GET", "/v1/settings")
    }

    // MARK: Mail

    public func folder(_ folder: Folder, limit: Int = 200) async throws -> [Message] {
        struct Page: Decodable { var messages: [Message] }
        let page: Page = try await send("GET", "/v1/folders/\(folder.rawValue)/messages", query: [URLQueryItem(name: "limit", value: String(limit))])
        return page.messages
    }

    public func thread(_ id: String) async throws -> ThreadResponse {
        try await send("GET", "/v1/threads/\(escaped(id))")
    }

    public func message(_ id: String) async throws -> Message {
        try await send("GET", "/v1/messages/\(escaped(id))")
    }

    public func body(_ id: String) async throws -> Envelope.Blob {
        struct Body: Decodable { var envelope: Envelope.Blob }
        let body: Body = try await send("GET", "/v1/messages/\(escaped(id))/body")
        return body.envelope
    }

    public func attachment(messageId: String, attachmentId: String) async throws -> AttachmentPayload {
        let (data, response) = try await perform(request("GET", "/v1/messages/\(escaped(messageId))/attachments/\(escaped(attachmentId))"))
        let type = (response.value(forHTTPHeaderField: "content-type") ?? "").lowercased()
        guard type.contains("application/json") else { return .plain(data) }
        struct Payload: Decodable { var url: String?; var envelope: Envelope.Blob? }
        let payload = try decode(Payload.self, data)
        if let envelope = payload.envelope { return .sealed(envelope) }
        if let text = payload.url, let url = URL(string: text), url.scheme == "https" { return .sealedAt(url) }
        throw APIError.decoding("attachment")
    }

    /// Presigned S3 URL: no bearer token goes to S3.
    public func download(_ url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        let (data, response) = try await perform(request)
        guard (200..<300).contains(response.statusCode) else { throw APIError.server(response.statusCode, "attachment download") }
        return data
    }

    public func search(_ query: String) async throws -> [Message] {
        struct Page: Decodable { var messages: [Message] }
        let page: Page = try await send("POST", "/v1/search", json: ["query": query, "mode": "keyword"])
        return page.messages
    }

    // The mutation routes answer with the stored record, not the `Message` view (no `locked`, internal keys),
    // so callers reload through `folder`/`thread` instead of decoding it.
    public func setUnread(_ id: String, _ unread: Bool) async throws {
        try await sendDiscardingBody("POST", "/v1/messages/\(escaped(id))/flags", json: ["unread": unread])
    }

    public func setLabels(_ id: String, _ labels: [String]) async throws {
        try await sendDiscardingBody("POST", "/v1/messages/\(escaped(id))/labels", json: ["labels": labels])
    }

    public func archive(_ id: String) async throws {
        try await sendDiscardingBody("POST", "/v1/messages/\(escaped(id))/archive")
    }

    /// `trash` is a soft delete: it stamps `trashedAt` and `keepUntil`, and `restore` undoes it.
    public func move(_ id: String, to folder: Folder) async throws {
        try await sendDiscardingBody("POST", "/v1/messages/\(escaped(id))/move", json: ["folder": folder.rawValue])
    }

    public func restore(_ id: String) async throws {
        try await sendDiscardingBody("POST", "/v1/messages/\(escaped(id))/restore")
    }

    // MARK: Drafts and approval

    public func drafts() async throws -> [DraftView] {
        struct Page: Decodable { var drafts: [DraftView] }
        let page: Page = try await send("GET", "/v1/drafts", query: [URLQueryItem(name: "text", value: "1")])
        return page.drafts
    }

    public func draft(_ id: String) async throws -> DraftView {
        try await send("GET", "/v1/drafts/\(escaped(id))", query: [URLQueryItem(name: "text", value: "1")])
    }

    public func createDraft(_ fields: DraftFields, threadId: String?, inReplyTo: String?) async throws -> DraftView {
        var body = fields.payload
        if let threadId { body["threadId"] = threadId }
        if let inReplyTo { body["inReplyTo"] = inReplyTo }
        return try await send("POST", "/v1/drafts", json: body)
    }

    public func updateDraft(_ id: String, _ fields: DraftFields) async throws -> DraftView {
        try await send("POST", "/v1/drafts/\(escaped(id))", json: fields.payload)
    }

    /// The AI writes a suggested reply. `sourceText` is the body this phone decrypted, because the API cannot open it.
    public func draftReply(messageId: String, sourceText: String?) async throws -> DraftView {
        let body: [String: Any] = sourceText.map { ["sourceText": $0] } ?? [:]
        return try await send("POST", "/v1/messages/\(escaped(messageId))/draft-reply", json: body)
    }

    public func rewrite(_ id: String, instruction: String) async throws -> DraftView {
        try await send("POST", "/v1/drafts/\(escaped(id))/rewrite", json: ["instruction": instruction])
    }

    public func submitForApproval(_ id: String) async throws -> DraftView {
        try await send("POST", "/v1/drafts/\(escaped(id))/submit")
    }

    public func discard(_ id: String) async throws -> DraftView {
        try await send("POST", "/v1/drafts/\(escaped(id))/discard")
    }

    /// Human sessions only. The server checks that `reviewed` is exactly what is stored and answers 409 if not.
    public func mintApproval(_ id: String, reviewed: DraftFields) async throws -> String {
        struct Minted: Decodable { var approvalToken: String }
        let minted: Minted = try await send("POST", "/v1/drafts/\(escaped(id))/approval", json: reviewed.approvalPayload)
        return minted.approvalToken
    }

    /// Proposed (ios/docs/API-ATTACHMENTS.md): one file per request, base64 in JSON, so a 4 MB message stays under
    /// API Gateway's and Lambda's request limits.
    public func addDraftAttachment(_ id: String, _ file: OutgoingAttachment) async throws -> DraftView {
        try await send("POST", "/v1/drafts/\(escaped(id))/attachments", json: [
            "filename": file.filename,
            "contentType": file.contentType,
            "sha256": file.sha256,
            "data": file.data.base64EncodedString(),
        ])
    }

    public func removeDraftAttachment(_ id: String, attachmentId: String) async throws -> DraftView {
        try await send("POST", "/v1/drafts/\(escaped(id))/attachments/\(escaped(attachmentId))/remove")
    }

    public func approveAndSend(_ id: String, approvalToken: String) async throws -> String {
        struct Sent: Decodable { var messageId: String }
        let sent: Sent = try await send("POST", "/v1/drafts/\(escaped(id))/approve-and-send", json: ["approvalToken": approvalToken])
        return sent.messageId
    }

    // MARK: Rules

    public func rules() async throws -> RulesState {
        try await send("GET", "/v1/rules")
    }

    public func setRuleSwitches(paused: Bool? = nil, killSwitch: Bool? = nil, sendKillSwitch: Bool? = nil) async throws -> RulesDocument {
        struct Reply: Decodable { var rules: RulesDocument }
        var body: [String: Any] = [:]
        if let paused { body["paused"] = paused }
        if let killSwitch { body["killSwitch"] = killSwitch }
        if let sendKillSwitch { body["sendKillSwitch"] = sendKillSwitch }
        let reply: Reply = try await send("POST", "/v1/rules/switches", json: body)
        return reply.rules
    }

    public func disableRule(_ id: String) async throws -> RulesDocument {
        struct Reply: Decodable { var rules: RulesDocument }
        let reply: Reply = try await send("POST", "/v1/rules/\(escaped(id))/disable")
        return reply.rules
    }

    // MARK: Plumbing

    private func escaped(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? component
    }

    func request(_ method: String, _ path: String, query: [URLQueryItem] = [], json: [String: Any]? = nil, authorized: Bool = true) throws -> URLRequest {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        guard var components = URLComponents(string: base + path) else { throw APIError.invalid("Bad API URL") }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.invalid("Bad API path") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if authorized, let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let json {
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        } else if method == "POST" {
            request.httpBody = Data("{}".utf8)
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        return request
    }

    func send<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], json: [String: Any]? = nil, authorized: Bool = true) async throws -> T {
        let (data, _) = try await perform(request(method, path, query: query, json: json, authorized: authorized))
        return try decode(T.self, data)
    }

    func sendDiscardingBody(_ method: String, _ path: String, json: [String: Any]? = nil) async throws {
        _ = try await perform(request(method, path, json: json))
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: T.self))
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
                throw APIError.offline
            default:
                throw APIError.network(error.localizedDescription)
            }
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.network("no HTTP response") }
        if (200..<300).contains(http.statusCode) { return (data, http) }
        let message = (try? JSONDecoder().decode(ApiErrorBody.self, from: data))?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
        switch http.statusCode {
        case 401: throw APIError.unauthorized
        case 403: throw APIError.forbidden(message)
        case 404: throw APIError.notFound(message)
        case 409: throw APIError.conflict(message)
        case 400, 422, 423: throw APIError.invalid(message)
        case 429: throw APIError.rateLimited(retryAfter: http.value(forHTTPHeaderField: "retry-after").flatMap(Int.init))
        default: throw APIError.server(http.statusCode, message)
        }
    }
}

/// What Jon reviews before approving, in the shape `POST /v1/drafts/:id/approval` expects.
public struct DraftFields: Sendable, Hashable {
    public var to: String
    public var cc: String
    public var subject: String
    public var text: String
    public var pgp: PgpMode
    /// SHA-256 of each file on the draft, in the server's order. Set from the server's draft view, never by editing:
    /// files are added and removed with their own calls, and the approval names exactly these.
    public var attachments: [String]

    public init(to: String = "", cc: String = "", subject: String = "", text: String = "", pgp: PgpMode = .auto, attachments: [String] = []) {
        self.to = to
        self.cc = cc
        self.subject = subject
        self.text = text
        self.pgp = pgp
        self.attachments = attachments
    }

    public init(_ view: DraftView) {
        self.init(
            to: view.draft.to.map(\.email).joined(separator: ", "),
            cc: view.draft.cc.map(\.email).joined(separator: ", "),
            subject: view.draft.subject,
            text: view.text ?? "",
            pgp: view.draft.pgp,
            attachments: (view.draft.attachments ?? []).map(\.sha256)
        )
    }

    public static func addresses(_ value: String) -> [String] {
        value.split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "\n" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    public var toList: [String] { DraftFields.addresses(to) }
    public var ccList: [String] { DraftFields.addresses(cc) }
    public var allRecipients: [String] { toList + ccList }

    var payload: [String: Any] {
        ["to": toList, "cc": ccList, "subject": subject, "text": text, "pgp": pgp.rawValue]
    }

    /// Servers without draft attachments reject unknown members, so `attachments` is only sent when there are some.
    var approvalPayload: [String: Any] {
        var body = payload
        if !attachments.isEmpty { body["attachments"] = attachments }
        return body
    }

    /// Same comparison as `changedFields` in `packages/web/src/review.ts`.
    public func changed(comparedTo current: DraftFields) -> [String] {
        var out: [String] = []
        let norm = { (value: String) in DraftFields.addresses(value).map { $0.lowercased() }.joined(separator: ",") }
        if norm(to) != norm(current.to) { out.append("recipients (To)") }
        if norm(cc) != norm(current.cc) { out.append("recipients (Cc)") }
        if subject != current.subject { out.append("subject") }
        if text != current.text { out.append("message text") }
        if pgp != current.pgp { out.append("encryption") }
        if attachments != current.attachments { out.append("attachments") }
        return out
    }
}
