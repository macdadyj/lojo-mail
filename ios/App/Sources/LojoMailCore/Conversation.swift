import Foundation

/// One row in a mailbox list: the messages of a thread that are in that folder, newest last.
public struct Conversation: Identifiable, Sendable, Hashable {
    public var id: String
    public var messages: [Message]

    public var latest: Message { messages[messages.count - 1] }
    public var subject: String { messages.first?.subject.nonEmpty ?? latest.subject.nonEmpty ?? "(no subject)" }
    public var unread: Bool { messages.contains(where: \.unread) }
    public var starred: Bool { messages.contains(where: \.starred) }
    public var hasAttachments: Bool { messages.contains { !$0.attachments.isEmpty } }
    public var phishy: Bool { messages.contains(where: \.looksPhishy) }
    public var count: Int { messages.count }
    public var date: Date? { latest.sentDate }

    /// Names of the other side, most recent first, without repeats.
    public func participants(me: String) -> String {
        var seen: [String] = []
        for message in messages.reversed() {
            let who: Address = message.origin == "sent" ? (message.to.first ?? message.from) : message.from
            let name = who.email.caseInsensitiveCompare(me) == .orderedSame ? "Me" : who.display
            if !seen.contains(name) { seen.append(name) }
        }
        return seen.prefix(3).joined(separator: ", ")
    }

    /// Groups a folder listing (newest first from the API) into conversations, newest conversation first.
    public static func group(_ messages: [Message]) -> [Conversation] {
        var order: [String] = []
        var byThread: [String: [Message]] = [:]
        for message in messages {
            if byThread[message.threadId] == nil { order.append(message.threadId) }
            byThread[message.threadId, default: []].append(message)
        }
        return order.compactMap { id in
            guard let items = byThread[id], !items.isEmpty else { return nil }
            let sorted = items.sorted { ($0.sentDate ?? .distantPast) < ($1.sentDate ?? .distantPast) }
            return Conversation(id: id, messages: sorted)
        }
        .sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }
}

/// What Forward opens in Compose. Recipients start empty. Every original file is carried until one is removed.
public struct ForwardCompose: Sendable, Equatable {
    public var to: String
    public var cc: String
    public var bcc: String
    public var subject: String
    public var text: String
    public private(set) var attachments: [AttachmentMeta]

    public init(message: Message, body: String, note: String = "") {
        to = ""
        cc = ""
        bcc = ""
        subject = MailText.forwardSubject(message.subject)
        text = MailText.forwardBody(note: note, original: body, message: message)
        attachments = message.attachments
    }

    /// Drops one original file before it is copied onto the outgoing draft.
    public mutating func removeAttachment(id: String) {
        attachments.removeAll { $0.id == id }
    }
}

public enum MailText {
    public static func replySubject(_ subject: String) -> String {
        prefixed(subject, "Re:")
    }

    /// `Fwd: ` once. A subject that already starts with `Fwd:` or `Fw:` is left as it is.
    public static func forwardSubject(_ subject: String) -> String {
        let trimmed = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        if alreadyForwarded(trimmed) { return trimmed }
        return "Fwd: \(trimmed)"
    }

    /// The line that starts the quoted original. A note, when there is one, is placed above it.
    public static let forwardSeparator = "---------- Forwarded message ----------"

    private static func alreadyForwarded(_ subject: String) -> Bool {
        let lower = subject.lowercased()
        return lower.hasPrefix("fwd:") || lower.hasPrefix("fw:")
    }

    private static func prefixed(_ subject: String, _ prefix: String) -> String {
        let trimmed = subject.trimmingCharacters(in: .whitespaces)
        if trimmed.lowercased().hasPrefix(prefix.lowercased()) { return trimmed }
        return "\(prefix) \(trimmed)"
    }

    public static func quoted(_ text: String, from: Address, date: Date?) -> String {
        let when = date.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "earlier"
        let body = text.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n")
        return "\n\nOn \(when), \(from.display) <\(from.email)> wrote:\n\(body)"
    }

    /// The original, under a blank line, so a note can be typed above the header.
    public static func forwarded(_ text: String, message: Message) -> String {
        forwardBody(note: "", original: text, message: message)
    }

    /// Note first, then the forwarded header (From, Date, Subject, To, and Cc when anyone was copied) and the original body.
    public static func forwardBody(note: String, original: String, message: Message) -> String {
        let quote = forwardQuote(original, message: message)
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "\n\n\(quote)" }
        return "\(trimmed)\n\n\(quote)"
    }

    private static func forwardQuote(_ text: String, message: Message) -> String {
        let when = message.sentDate.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? message.date
        var lines = [
            forwardSeparator,
            "From: \(addressList([message.from]))",
            "Date: \(when)",
            "Subject: \(message.subject)",
            "To: \(addressList(message.to))",
        ]
        let copied = message.cc ?? []
        if !copied.isEmpty { lines.append("Cc: \(addressList(copied))") }
        return lines.joined(separator: "\n") + "\n\n" + text
    }

    private static func addressList(_ addresses: [Address]) -> String {
        addresses.map(addressLine).joined(separator: ", ")
    }

    private static func addressLine(_ address: Address) -> String {
        let name = address.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if name.isEmpty || name.caseInsensitiveCompare(address.email) == .orderedSame {
            return address.email
        }
        return "\(name) <\(address.email)>"
    }

    /// Reply All. To is the sender plus the original To line. Cc is the original Cc line.
    /// `me` is every address Jon sends as. Those, and repeats, are left out.
    public static func replyAll(to message: Message, me: String) -> (to: [String], cc: [String]) {
        replyAll(to: message, me: [me])
    }

    public static func replyAll(to message: Message, me: [String]) -> (to: [String], cc: [String]) {
        let mine = Set(me.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty })
        var seen = mine
        func take(_ email: String, into list: inout [String]) {
            let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = trimmed.lowercased()
            guard !key.isEmpty, seen.insert(key).inserted else { return }
            list.append(trimmed)
        }
        var to: [String] = []
        var cc: [String] = []
        let fromSelf = message.origin == "sent" || mine.contains(message.from.email.lowercased())
        if !fromSelf { take(message.from.email, into: &to) }
        for address in message.to { take(address.email, into: &to) }
        for address in message.cc ?? [] { take(address.email, into: &cc) }
        return (to, cc)
    }

    /// In-Reply-To is the message's own id. References is the chain, with that id last, once.
    public static func replyReferences(of message: Message) -> [String] {
        var chain: [String] = []
        var seen = Set<String>()
        let ids = (message.references ?? []) + (message.rfcMessageId.map { [$0] } ?? [])
        for id in ids {
            let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = trimmed.lowercased()
            guard !key.isEmpty, seen.insert(key).inserted else { continue }
            chain.append(trimmed)
        }
        return chain
    }

    /// A readable plain-text fallback for HTML-only mail. Scripts, styles and remote content never load.
    public static func plainText(fromHTML html: String) -> String {
        var text = html
        for tag in ["script", "style", "head"] {
            text = text.replacingOccurrences(of: "<\(tag)[^>]*>[\\s\\S]*?</\(tag)>", with: "", options: [.regularExpression, .caseInsensitive])
        }
        text = text.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "</(p|div|tr|li|h[1-6])>", with: "\n", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "<li[^>]*>", with: "• ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        let entities = ["&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'"]
        for (entity, value) in entities { text = text.replacingOccurrences(of: entity, with: value) }
        text = text.replacingOccurrences(of: "[ \\t]+\n", with: "\n", options: .regularExpression)
        text = text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
