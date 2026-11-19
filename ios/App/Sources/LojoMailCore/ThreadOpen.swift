import Foundation

public enum ThreadOpenError: Error, LocalizedError, Equatable {
    case notFound(String)

    public var errorDescription: String? {
        switch self {
        case .notFound(let id):
            "No thread \(id)"
        }
    }
}

/// Which messages belong to the conversation the list opened.
public enum ThreadOpen {
    /// Messages whose thread id is `threadId`, oldest first. Another conversation is left out.
    public static func listed(_ threadId: String, in messages: [Message]) -> [Message] {
        var byId: [String: Message] = [:]
        for message in messages where message.threadId == threadId {
            byId[message.id] = message
        }
        return byId.values.sorted { lhs, rhs in
            let left = lhs.sentDate ?? .distantPast
            let right = rhs.sentDate ?? .distantPast
            if left != right { return left < right }
            return lhs.id < rhs.id
        }
    }
}
