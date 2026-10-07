import SwiftUI
import UserNotifications

@main
struct LojoMailApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Theme.accent)
                .task {
                    UNUserNotificationCenter.current().delegate = model.notificationRouter
                    model.start()
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                model.startPolling()
                if model.phase == .ready { Task { await model.refreshAll() } }
            case .background:
                model.stopPolling()
                Notifier.scheduleRefresh()
                if model.incomingKey == nil { Provisioning.purgeInbox() }
            case .inactive:
                break
            @unknown default:
                break
            }
        }
        .backgroundTask(.appRefresh(Notifier.refreshTaskId)) {
            await model.backgroundRefresh()
        }
    }
}
