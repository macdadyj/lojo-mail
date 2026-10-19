import Foundation

/// Plain words for the first screens. The names Filter with SI, Reply with SI, and Approve and send stay.
public enum SetupCopy {
    public static let accountLabel = "Account"
    public static let accountDetail = "The mailbox you sign in to."
    public static let siTitle = "SI"
    public static let siDetail = "Filter with SI sorts mail. Reply with SI writes a draft. Nothing sends until you tap Approve and send."
    public static let approvalsTitle = "Approval queue"
    public static let approvalsDetail = "Drafts wait here until you open one and tap Approve and send."

    public static let steps: [String] = [
        "Sign in with your passphrase.",
        "Load the envelope key so this iPhone can open sealed mail.",
        "Read your mail, and tap Approve and send when a draft is ready."
    ]
}
