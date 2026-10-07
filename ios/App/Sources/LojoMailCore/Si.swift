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
