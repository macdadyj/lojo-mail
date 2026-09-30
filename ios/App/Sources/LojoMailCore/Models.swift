import Foundation

/// Mirrors `packages/web/src/types.ts` and the `/v1` API in `packages/api/src/app.ts`.
/// Every field the server may omit is optional so a new server field or a missing one never breaks decoding.

public enum Folder: String, CaseIterable, Codable, Sendable, Identifiable {
    case inbox, sent, drafts, spam, trash, archive

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .inbox: "Inbox"
        case .sent: "Sent"
        case .drafts: "Drafts"
        case .spam: "Junk"
        case .trash: "Trash"
        case .archive: "Archive"
        }
    }

    public var systemImage: String {
        switch self {
        case .inbox: "tray"
        case .sent: "paperplane"
        case .drafts: "doc"
        case .spam: "xmark.bin"
        case .trash: "trash"
        case .archive: "archivebox"
        }
    }

    /// Where a message can be moved by hand. Drafts is not a filing target and Sent only takes mail Jon sent.
    public static let moveTargets: [Folder] = [.inbox, .archive, .spam, .trash]
}

public struct Address: Codable, Sendable, Hashable {
    public var name: String?
    public var email: String

    public init(name: String? = nil, email: String) {
        self.name = name
        self.email = email
    }

    public var display: String {
        if let name, !name.isEmpty { return name }
        return email
    }
}

public struct AttachmentMeta: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var filename: String
    public var contentType: String
    public var size: Int
}

public struct AiPublic: Codable, Sendable, Hashable {
    public var category: String?
    public var priority: String?
    public var phishingScore: Double?
    public var labels: [String]?
    public var unsubscribeDetected: Bool?
    public var skipped: Bool?
    public var skipReason: String?
}

public struct Verdicts: Codable, Sendable, Hashable {
    public var spam: String?
    public var virus: String?
    public var spf: String?
    public var dkim: String?
    public var dmarc: String?
}

public struct ActionItem: Codable, Sendable, Hashable {
    public var text: String
    public var deadline: String?
}

public struct Message: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var threadId: String
    public var rfcMessageId: String?
    public var references: [String]?
    public var folder: String
    public var origin: String
    public var from: Address
    public var to: [Address]
    public var cc: [Address]?
    public var subject: String
    public var date: String
    public var snippet: String?
    public var unread: Bool
    public var labels: [String]
    public var bulk: Bool?
    public var pgpEncrypted: Bool?
    public var verdicts: Verdicts?
    public var ai: AiPublic?
    public var locked: Bool
    public var text: String?
    public var summary: String?
    public var attachments: [AttachmentMeta]
    public var trashedAt: String?
    public var trashedBy: String?
    public var keepUntil: String?

    public static let starLabel = "flagged"

    public var starred: Bool { labels.contains(Message.starLabel) }
    public var folderValue: Folder? { Folder(rawValue: folder) }
    public var sentDate: Date? { ISODate.parse(date) }
    public var phishingScore: Double { ai?.phishingScore ?? 0 }
    public var looksPhishy: Bool { phishingScore >= 40 }
}

/// The decrypted content of `objects/{id}.bin`.
public struct SealedBody: Codable, Sendable, Hashable {
    public struct AI: Codable, Sendable, Hashable {
        public var summary: String?
        public var threadSummary: String?
        public var actionItems: [ActionItem]?
        public var draftReply: String?
        public var phishingReasons: [String]?
    }

    public var text: String
    public var html: String?
    public var ai: AI?

    public init(text: String, html: String? = nil, ai: AI? = nil) {
        self.text = text
        self.html = html
        self.ai = ai
    }
}

public struct ThreadInfo: Codable, Sendable, Hashable {
    public var id: String
    public var subject: String
}

public struct ThreadResponse: Codable, Sendable {
    public var thread: ThreadInfo?
    public var messages: [Message]
}

public enum DraftStatus: String, Codable, Sendable {
    case suggested
    case edited
    case pendingApproval = "pending_approval"
    case sending
    case sent
    case discarded

    public var label: String {
        switch self {
        case .suggested: "Suggested"
        case .edited: "Draft"
        case .pendingApproval: "Needs approval"
        case .sending: "Sending"
        case .sent: "Sent"
        case .discarded: "Discarded"
        }
    }

    public var editable: Bool {
        switch self {
        case .suggested, .edited, .pendingApproval: true
        case .sending, .sent, .discarded: false
        }
    }
}

public enum DraftAuthor: String, Codable, Sendable {
    case human, agent, ai, client, rule

    /// Who wrote it, in words. `nil` for Jon himself.
    public var writer: String? {
        switch self {
        case .human: nil
        case .agent: "An assistant"
        case .ai: "The AI"
        case .client: "Thunderbird (through the local bridge)"
        case .rule: "One of your mail rules"
        }
    }

    public var chip: String {
        switch self {
        case .human: "You"
        case .agent: "Assistant"
        case .ai: "AI"
        case .client: "Thunderbird"
        case .rule: "Rule"
        }
    }

    public var isBot: Bool {
        switch self {
        case .human, .client: false
        case .agent, .ai, .rule: true
        }
    }
}

public enum PgpMode: String, Codable, Sendable, CaseIterable {
    case auto, off
}

public struct Draft: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var threadId: String?
    public var inReplyTo: String?
    public var to: [Address]
    public var cc: [Address]
    public var subject: String
    public var status: DraftStatus
    public var origin: DraftAuthor
    public var lastEditedBy: DraftAuthor?
    public var aiGenerated: Bool?
    public var pgp: PgpMode
    public var createdAt: String
    public var updatedAt: String
    public var sentMessageId: String?

    /// Same wording as `authorNotice` in `packages/web/src/review.ts`: depends on who wrote the content, never on status.
    public var authorNotice: String? {
        let author = origin.writer
        let editor = lastEditedBy.flatMap { $0 != origin ? $0.writer : nil }
        if author == nil && editor == nil { return nil }
        var parts: [String] = []
        if let author { parts.append("\(author) wrote this draft") }
        if let editor { parts.append("\(author == nil ? editor : editor.lowercasedFirst) last changed \(author == nil ? "this draft" : "it")") }
        let asked = status == .pendingApproval ? " It is waiting for your approval." : ""
        return parts.joined(separator: ", and ") + "." + asked + " Check the recipients and the text before you send."
    }
}

public struct DraftView: Codable, Sendable, Hashable, Identifiable {
    public var draft: Draft
    public var text: String?
    public var id: String { draft.id }
}

public struct Session: Codable, Sendable, Hashable {
    public var sessionToken: String
    public var expiresAt: String

    public init(sessionToken: String, expiresAt: String) {
        self.sessionToken = sessionToken
        self.expiresAt = expiresAt
    }

    public var expiry: Date? { ISODate.parse(expiresAt) }

    public func isValid(at now: Date = Date(), margin: TimeInterval = 60) -> Bool {
        guard sessionToken.hasPrefix("hs_"), let expiry else { return false }
        return expiry.timeIntervalSince(now) > margin
    }
}

public struct ServerSettings: Codable, Sendable, Hashable {
    public var mailbox: String
    public var domain: String
    public var llmProvider: String
    public var embedProvider: String?
    public var dailyTokenBudget: Int
    public var budgetUsed: Int
    public var unlocked: Bool
    public var dev: Bool
    public var principal: String
}

public struct RuleReply: Codable, Sendable, Hashable {
    public var mode: String
    public var template: String?
    public var allowSenders: [String]?
    public var perDay: Int?
    public var perSenderPerDay: Int?

    public var autoSend: Bool { mode == "autoSend" }
}

public struct RuleAction: Codable, Sendable, Hashable {
    public var type: String
    public var labels: [String]?
    public var folder: String?
    public var reply: RuleReply?

    public var summary: String {
        switch type {
        case "label": "Label \((labels ?? []).joined(separator: ", "))"
        case "move": "Move to \(Folder(rawValue: folder ?? "")?.title ?? folder ?? "?")"
        case "markRead": "Mark read"
        case "trash": "Move to Trash"
        case "reply": reply?.autoSend == true ? "Auto-reply (guarded)" : "Draft a reply for approval"
        default: type
        }
    }
}

public struct Rule: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var enabled: Bool
    public var actions: [RuleAction]
    public var stop: Bool?
    public var createdBy: String?
    public var updatedAt: String?

    public var autoSends: Bool { actions.contains { $0.reply?.autoSend == true } }
}

public struct RulesDocument: Codable, Sendable, Hashable {
    public var paused: Bool
    public var killSwitch: Bool
    /// Stops every send: approved human sends, bridge sends and auto-send. Older servers omit it.
    public var sendKillSwitch: Bool?
    public var trashRetentionDays: Int?
    public var maxAutoSendPerDay: Int?
    public var rules: [Rule]
    public var updatedAt: String?
    public var updatedBy: String?
}

public struct RulesState: Codable, Sendable, Hashable {
    public var rules: RulesDocument
    public var autoSendEnabled: Bool
}

public struct ApiErrorBody: Codable, Sendable {
    public var error: String?
    public var code: String?
}

public enum ISODate {
    public static func parse(_ value: String) -> Date? {
        if let date = try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
        return try? Date(value, strategy: Date.ISO8601FormatStyle())
    }
}

extension String {
    var lowercasedFirst: String {
        guard let first else { return self }
        return first.lowercased() + dropFirst()
    }
}
