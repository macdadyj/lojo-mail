import Foundation

/// How much of a message the inbox and the thread show. The numbers stay in the core so a
/// Dynamic Type change is a test, not only a SwiftUI tweak.
public enum MailReading {
    /// Extra space between lines of an opened message. The list stays tighter than the thread.
    public static let bodyLineSpacing: Double = 6
    /// Points between inbox rows. Small enough that a long inbox still scans.
    public static let listRowSpacing: Double = 2

    public static func subjectLineLimit(accessibilitySize: Bool) -> Int {
        accessibilitySize ? 3 : 2
    }

    public static func snippetLineLimit(accessibilitySize: Bool) -> Int {
        accessibilitySize ? 4 : 2
    }

    /// What VoiceOver reads for one inbox row. Unread is said first so it is not lost in the subject.
    public static func rowLabel(unread: Bool, sender: String, count: Int, subject: String, snippet: String?, starred: Bool, attachments: Bool) -> String {
        var parts: [String] = []
        if unread { parts.append("Unread") }
        let who = sender.trimmingCharacters(in: .whitespacesAndNewlines)
        if !who.isEmpty { parts.append(who) }
        if count > 1 { parts.append("\(count) messages") }
        let title = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        parts.append(title.isEmpty ? "(no subject)" : title)
        if let snippet {
            let preview = snippet.trimmingCharacters(in: .whitespacesAndNewlines)
            if !preview.isEmpty { parts.append(preview) }
        }
        if starred { parts.append("Starred") }
        if attachments { parts.append("Has attachments") }
        return parts.joined(separator: ". ")
    }
}
