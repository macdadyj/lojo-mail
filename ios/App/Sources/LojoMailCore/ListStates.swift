import Foundation

/// Empty, loading, and error copy for the three lists people scan: Inbox, search, and the approval queue.
public enum MailList: String, Sendable {
    case inbox
    case search
    case approval
}

public struct ListNotice: Equatable, Sendable {
    public var title: String
    public var message: String

    public init(title: String, message: String) {
        self.title = title
        self.message = message
    }
}

public enum ListStates {
    public static let tryAgain = "Try again"

    public static func loading(_ list: MailList) -> String {
        switch list {
        case .inbox:
            return "Loading Inbox…"
        case .search:
            return "Searching…"
        case .approval:
            return "Loading the approval queue…"
        }
    }

    public static func empty(_ list: MailList, mailbox: String = "") -> ListNotice {
        switch list {
        case .inbox:
            let who = mailbox.trimmingCharacters(in: .whitespacesAndNewlines)
            let message = who.isEmpty ? "New mail shows up here." : "New mail to \(who) shows up here."
            return ListNotice(title: "Inbox zero", message: message)
        case .search:
            return ListNotice(title: "No matches", message: "Nothing in all mail matches those words.")
        case .approval:
            return ListNotice(title: "Nothing waiting", message: "Drafts you need to approve show up here. Nothing sends until you tap Approve and send.")
        }
    }

    public static func failed(_ list: MailList) -> ListNotice {
        switch list {
        case .inbox:
            return ListNotice(title: "Couldn't load Inbox", message: "Check the connection and try again.")
        case .search:
            return ListNotice(title: "Couldn't search", message: "Check the connection and try again.")
        case .approval:
            return ListNotice(title: "Couldn't load the approval queue", message: "Check the connection and try again.")
        }
    }
}
