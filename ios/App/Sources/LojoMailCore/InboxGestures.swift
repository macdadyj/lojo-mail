import Foundation

/// Names shared by the inbox swipe buttons and the VoiceOver actions that do the same thing.
public enum InboxGestures {
    public static let archive = "Archive"

    public static func markRead(unread: Bool) -> String {
        unread ? "Mark as read" : "Mark as unread"
    }
}
