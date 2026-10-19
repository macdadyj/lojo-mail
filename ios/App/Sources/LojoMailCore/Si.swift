import Foundation

/// Tones for Reply with SI. The draft is never sent from this screen.
public enum SiTone: String, CaseIterable, Codable, Sendable, Equatable {
    case friendly, brief, formal, warm, direct

    public var title: String {
        switch self {
        case .friendly: "Friendly"
        case .brief: "Brief"
        case .formal: "Formal"
        case .warm: "Warm"
        case .direct: "Direct"
        }
    }
}

/// Labels SI is asked to use. Applying one creates it: the mailbox lists it as a folder.
public enum SiLabels {
    public static let suggested = ["receipts", "newsletters", "church", "family", "work"]

    public static func title(_ label: String) -> String {
        switch label {
        case "receipts": return "Receipts"
        case "newsletters": return "Newsletters"
        case "church": return "Church"
        case "family": return "Family"
        case "work": return "Work"
        default:
            return label.split(separator: " ").map { word in
                guard let first = word.first else { return "" }
                return first.uppercased() + word.dropFirst()
            }.joined(separator: " ")
        }
    }
}

public struct SiAction: Codable, Sendable, Hashable, Equatable {
    public var type: String
    public var labels: [String]?

    public init(type: String, labels: [String]? = nil) {
        self.type = type
        self.labels = labels
    }

    /// Permanent delete is not an action SI can take.
    public var isSafe: Bool {
        switch type {
        case "label", "spam", "trash", "blockSender", "blockDomain": true
        default: false
        }
    }

    public func summary(from: String, domain: String) -> String {
        switch type {
        case "label": "Label \((labels ?? []).map(SiLabels.title).joined(separator: ", "))"
        case "spam": "Mark as junk"
        case "trash": "Move to Trash"
        case "blockSender": "Block \(from)"
        case "blockDomain": "Block @\(domain)"
        default: type
        }
    }
}

public struct SiProposal: Codable, Sendable, Hashable, Equatable, Identifiable {
    public var messageId: String
    public var from: String
    public var domain: String
    public var subject: String
    public var reason: String
    public var actions: [SiAction]
    public var saveRule: Bool

    public var id: String { messageId }

    public var safeActions: [SiAction] { actions.filter(\.isSafe) }

    /// What the apply request sends. Unsafe actions, including a hard delete, are left out.
    public var forApply: SiProposal {
        var copy = self
        copy.actions = safeActions
        return copy
    }
}

public struct SiFilterResult: Codable, Sendable, Equatable {
    public var killSwitch: Bool
    public var proposals: [SiProposal]
}

public struct SiApplyResult: Codable, Sendable, Equatable {
    public var changeId: String
    public var applied: Int
    public var rules: Int
    public var undo: Bool
}

public struct SiBlockedPage: Codable, Sendable, Equatable {
    public var blocked: [SiBlock]
    public var changeId: String?
}

public struct SiBlock: Codable, Sendable, Hashable, Equatable, Identifiable {
    public var ruleId: String
    public var kind: String
    public var value: String
    public var name: String

    public var id: String { ruleId }

    public var title: String {
        switch kind {
        case "domain": "Domain \(value)"
        case "sender": value
        default: value
        }
    }
}

/// What the Filter with SI sheet shows: a selection, apply-all, and one row at a time.
public struct SiFilterScreen: Sendable, Equatable {
    public var proposals: [SiProposal]
    public var selected: Set<String>
    public var killSwitch: Bool

    public init(result: SiFilterResult) {
        proposals = result.proposals
        killSwitch = result.killSwitch
        selected = Set(result.proposals.filter { !$0.safeActions.isEmpty }.map(\.messageId))
    }

    public var canApply: Bool { !killSwitch && !applyAll.isEmpty }

    public var applyAll: [SiProposal] {
        guard !killSwitch else { return [] }
        return proposals.filter { selected.contains($0.messageId) }.map(\.forApply).filter { !$0.actions.isEmpty }
    }

    public func applyOne(_ messageId: String) -> [SiProposal] {
        guard !killSwitch, let proposal = proposals.first(where: { $0.messageId == messageId }) else { return [] }
        let prepared = proposal.forApply
        return prepared.actions.isEmpty ? [] : [prepared]
    }

    public mutating func toggle(_ messageId: String) {
        if selected.contains(messageId) { selected.remove(messageId) } else { selected.insert(messageId) }
    }

    public mutating func setSaveRule(_ messageId: String, _ on: Bool) {
        guard let index = proposals.firstIndex(where: { $0.messageId == messageId }) else { return }
        proposals[index].saveRule = on
    }
}

/// Reply with SI. Generating fills a draft; sending stays on Compose, behind approval.
public struct SiReplyScreen: Sendable, Equatable {
    public var tone: SiTone
    public var instruction: String

    public init(tone: SiTone = .friendly, instruction: String = "") {
        self.tone = tone
        self.instruction = instruction
    }

    /// SI never sends. Compose still asks Jon to approve.
    public var sendsAutomatically: Bool { false }
    public var opensInCompose: Bool { true }
    public var canGenerate: Bool { instruction.count <= 500 }
}

public extension Rule {
    var isSiRule: Bool { id.hasPrefix("si-") }
    var isSiBlock: Bool { id.hasPrefix("si-block-") }
}

/// Buttons that sit beside Reply. They are peers, not items in an overflow menu.
public enum SiEntry {
    public static let icon = "sparkles"
    public static let replyTitle = "Reply with SI"
    public static let replyAllTitle = "Reply All"
    public static let replyAllWithSiTitle = "Reply All with SI"
    public static let filterTitle = "Filter with SI"
    public static let actionBar = ["Reply", replyAllTitle, replyTitle, replyAllWithSiTitle, filterTitle]
    public static let futureMail = "Also apply to future mail from this sender"
}

/// Direct Filter with SI choices on one message. "Let SI decide" opens the proposal list.
public enum SiDirectChoice: String, CaseIterable, Sendable, Equatable {
    case spam, label, blockSender, trash, decide

    public var title: String {
        switch self {
        case .spam: "Filter to Spam"
        case .label: "Filter to Label…"
        case .blockSender: "Block sender"
        case .trash: "Move to Trash"
        case .decide: "Let SI decide"
        }
    }

    public var systemImage: String {
        switch self {
        case .spam: "xmark.bin"
        case .label: "folder"
        case .blockSender: "hand.raised"
        case .trash: "trash"
        case .decide: SiEntry.icon
        }
    }

    /// Label needs a chip first. Let SI decide opens the other sheet.
    public var appliesOnTap: Bool {
        switch self {
        case .spam, .blockSender, .trash: true
        case .label, .decide: false
        }
    }
}

/// Compact Filter with SI sheet. Deletes are Trash. A kill switch yields nothing to apply.
public struct SiMessageFilter: Sendable, Equatable {
    public var messageIds: [String]
    public var from: String
    public var domain: String
    public var subject: String
    public var suggestedLabel: String
    public var existingLabels: [String]
    public var selectedLabel: String
    public var customLabel: String
    public var makingNewLabel: Bool
    public var saveForFuture: Bool
    public var killSwitch: Bool

    public init(
        messageIds: [String],
        from: String,
        domain: String,
        subject: String,
        existingLabels: [String] = [],
        saveForFuture: Bool = false,
        killSwitch: Bool = false
    ) {
        self.messageIds = messageIds
        self.from = from.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.domain = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.subject = subject
        suggestedLabel = ""
        self.existingLabels = existingLabels
        selectedLabel = ""
        customLabel = ""
        makingNewLabel = false
        self.saveForFuture = saveForFuture
        self.killSwitch = killSwitch
    }

    /// Existing labels, with the label SI suggested first when it is not already there.
    public var labelChips: [String] {
        var chips: [String] = []
        if let suggested = SiLabels.normalize(suggestedLabel), !chips.contains(suggested) { chips.append(suggested) }
        for label in existingLabels {
            guard let clean = SiLabels.normalize(label), !chips.contains(clean) else { continue }
            chips.append(clean)
        }
        return chips
    }

    public func isSuggested(_ label: String) -> Bool {
        guard let suggested = SiLabels.normalize(suggestedLabel), let chip = SiLabels.normalize(label) else { return false }
        return suggested == chip
    }

    public mutating func useSuggestion(_ label: String?) {
        guard let clean = label.flatMap(SiLabels.normalize) else { return }
        suggestedLabel = clean
        if selectedLabel.isEmpty { selectedLabel = clean }
    }

    public var resolvedLabel: String? {
        if makingNewLabel { return SiLabels.normalize(customLabel) }
        return SiLabels.normalize(selectedLabel)
    }

    /// One proposal per message. Unsafe choices, including a hard delete, are not representable.
    public func proposals(for choice: SiDirectChoice) -> [SiProposal] {
        guard !killSwitch else { return [] }
        let ids = messageIds.filter { !$0.isEmpty }
        guard !ids.isEmpty else { return [] }
        let action: SiAction
        switch choice {
        case .spam:
            action = SiAction(type: "spam")
        case .trash:
            action = SiAction(type: "trash")
        case .blockSender:
            guard saveForFuture, from.contains("@") else { return [] }
            action = SiAction(type: "blockSender")
        case .label:
            guard let label = resolvedLabel else { return [] }
            action = SiAction(type: "label", labels: [label])
        case .decide:
            return []
        }
        return ids.map { id in
            SiProposal(
                messageId: id,
                from: from,
                domain: domain,
                subject: subject,
                reason: choice.title,
                actions: [action],
                saveRule: saveForFuture
            )
        }
    }
}

public extension SiLabels {
    /// The same shape the server keeps. "flagged" is the star, not a folder.
    static func normalize(_ raw: String) -> String? {
        let label = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !label.isEmpty, label != "flagged", label.count <= 40 else { return nil }
        guard let first = label.first, first.isLetter || first.isNumber else { return nil }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789 _./-")
        guard label.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return label
    }
}
