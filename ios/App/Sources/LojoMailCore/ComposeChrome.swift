import Foundation

/// Labels and sizes for the compose screen. Kept in the core so a Dynamic Type or
/// VoiceOver change is a test, not only a SwiftUI tweak.
public enum ComposeChrome {
    public static let toLabel = "To"
    public static let ccLabel = "Cc"
    public static let subjectLabel = "Subject"
    public static let messageLabel = "Message"
    public static let placeholder = "Write your message"
    public static let approvalNote = "Nothing sends until you approve it."

    /// Extra space between lines in the editor, the same rhythm as an opened message.
    public static let bodyLineSpacing: Double = 6

    public static func editorMinHeight(accessibilitySize: Bool) -> Double {
        accessibilitySize ? 360 : 260
    }

    /// Moves the keyboard focus one field toward the message, or leaves the body.
    public static func nextField(_ field: ComposeField?) -> ComposeField? {
        switch field {
        case .to: return .cc
        case .cc: return .subject
        case .subject: return .body
        case .body, nil: return nil
        }
    }

    /// Moves the keyboard focus one field back toward To.
    public static func previousField(_ field: ComposeField?) -> ComposeField? {
        switch field {
        case .cc: return .to
        case .subject: return .cc
        case .body: return .subject
        case .to, nil: return nil
        }
    }
}

public enum ComposeField: String, CaseIterable, Sendable {
    case to
    case cc
    case subject
    case body

    public var accessibilityLabel: String {
        switch self {
        case .to: return ComposeChrome.toLabel
        case .cc: return ComposeChrome.ccLabel
        case .subject: return ComposeChrome.subjectLabel
        case .body: return ComposeChrome.messageLabel
        }
    }
}
