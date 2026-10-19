import Foundation

/// A mailbox search. Every word has to appear in the subject, sender, snippet, or labels.
public struct MailSearchQuery: Equatable, Sendable {
    public var text: String
    public var terms: [String]

    public init(_ raw: String) {
        text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        terms = text.lowercased().split { $0.isWhitespace }.map(String.init)
    }

    public var isEmpty: Bool { terms.isEmpty }
}

public enum MailSearch {
    public static let prompt = "Search all mail"
    public static let recentLimit = 6
    /// UserDefaults key for the recent list. It is not the test-mode flag and it is not a key.
    public static let recentDefaultsKey = "mail.recentSearches"

    public static func matches(subject: String, senderName: String, senderEmail: String, snippet: String?, labels: [String], query: MailSearchQuery) -> Bool {
        if query.isEmpty { return true }
        let haystack = [subject, senderName, senderEmail, snippet ?? "", labels.joined(separator: " ")]
            .joined(separator: "\n")
            .lowercased()
        return query.terms.allSatisfy { haystack.contains($0) }
    }

    /// Most recent first, duplicates dropped, empty text ignored.
    public static func remember(_ query: String, recent: [String]) -> [String] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Array(recent.prefix(recentLimit)) }
        let next = [trimmed] + recent.filter { $0.caseInsensitiveCompare(trimmed) != .orderedSame }
        return Array(next.prefix(recentLimit))
    }

    public static func allMailSuggestion(_ query: String) -> String {
        "Search all mail for \"\(query.trimmingCharacters(in: .whitespacesAndNewlines))\""
    }

    public static func resultsTitle(count: Int) -> String {
        let noun = count == 1 ? "result" : "results"
        return "\(count) \(noun) in all mail · subject, sender, snippet, and labels"
    }
}
