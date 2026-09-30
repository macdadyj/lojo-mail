import BackgroundTasks
import Foundation
import LojoMailCore
import UserNotifications

/// Local notifications for new mail found by a foreground poll or a background app refresh.
/// There is no push: APNs needs the `aps-environment` entitlement, which a free Apple ID cannot sign.
enum Notifier {
    static let refreshTaskId = "com.lojo.Mail.refresh"
    private static let seenKey = "notifier.seenIds"
    private static let seededKey = "notifier.seeded"

    static func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])) ?? false
    }

    static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// Asks iOS for a background refresh no sooner than 15 minutes from now. iOS decides when, or whether, it runs.
    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Returns unread inbound inbox messages not seen before. The first call only records what is there.
    static func newMessages(in inbox: [Message]) -> [Message] {
        let defaults = UserDefaults.standard
        var seen = Set(defaults.stringArray(forKey: seenKey) ?? [])
        let seeded = defaults.bool(forKey: seededKey)
        let fresh = inbox.filter { $0.unread && $0.origin == "inbound" && !seen.contains($0.id) }
        seen.formUnion(inbox.map(\.id))
        defaults.set(Array(seen.suffix(1000)), forKey: seenKey)
        defaults.set(true, forKey: seededKey)
        return seeded ? fresh : []
    }

    static func post(_ messages: [Message], showSubject: Bool) async {
        guard !messages.isEmpty, await authorizationStatus() == .authorized else { return }
        let center = UNUserNotificationCenter.current()
        for message in messages.prefix(5) {
            let content = UNMutableNotificationContent()
            content.title = message.from.display
            content.body = showSubject ? (message.subject.isEmpty ? "(no subject)" : message.subject) : "New message"
            if message.looksPhishy { content.subtitle = "Possible phishing" }
            content.sound = .default
            content.threadIdentifier = message.threadId
            content.userInfo = ["threadId": message.threadId]
            try? await center.add(UNNotificationRequest(identifier: message.id, content: content, trigger: nil))
        }
        if messages.count > 5 {
            let content = UNMutableNotificationContent()
            content.title = "LOJO Mail"
            content.body = "\(messages.count - 5) more new messages"
            try? await center.add(UNNotificationRequest(identifier: "more-\(UUID().uuidString)", content: content, trigger: nil))
        }
    }

    static func setBadge(_ count: Int) async {
        guard await authorizationStatus() == .authorized else { return }
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }

    static func resetSeen() {
        UserDefaults.standard.removeObject(forKey: seenKey)
        UserDefaults.standard.removeObject(forKey: seededKey)
    }
}

/// Routes a tapped notification to its thread.
final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    var onOpenThread: (@MainActor @Sendable (String) -> Void)?

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let threadId = response.notification.request.content.userInfo["threadId"] as? String else { return }
        let handler = onOpenThread
        await MainActor.run { handler?(threadId) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }
}
