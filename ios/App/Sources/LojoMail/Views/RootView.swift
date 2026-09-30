import LocalAuthentication
import LojoMailCore
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: Tab = .mail
    @State private var locked = false
    @State private var obscured = false

    enum Tab: Hashable { case mail, review, rules, settings }

    var body: some View {
        ZStack {
            switch model.phase {
            case .launching:
                ProgressView().controlSize(.large)
            case .signedOut:
                SignInView()
            case .ready:
                tabs
            }
            if locked || (obscured && model.appLockEnabled) {
                LockView(locked: locked) { Task { await unlock() } }
                    .transition(.opacity)
            }
        }
        .onChange(of: scenePhase) { old, phase in
            obscured = phase != .active
            if phase == .background && model.appLockEnabled { locked = true }
            if phase == .active && locked { Task { await unlock() } }
        }
        .onAppear {
            if model.appLockEnabled { locked = true; Task { await unlock() } }
            applyLaunchTab()
        }
        .onChange(of: model.openThreadRequest) { _, id in if id != nil { tab = .mail } }
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            MailboxView()
                .tabItem { Label("Mail", systemImage: "envelope") }
                .tag(Tab.mail)
            ReviewView()
                .tabItem { Label("Review", systemImage: "checkmark.seal") }
                .badge(model.reviewCount)
                .tag(Tab.review)
            RulesView()
                .tabItem { Label("AI Rules", systemImage: "wand.and.stars") }
                .tag(Tab.rules)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastView(toast: toast) {
                    if let undo = toast.undo { Task { await model.perform(undo) } }
                }
                .padding(.bottom, 60)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task(id: toast.id) {
                    try? await Task.sleep(for: .seconds(toast.undo == nil ? 3 : 6))
                    if model.toast?.id == toast.id { withAnimation { model.toast = nil } }
                }
            }
        }
        .animation(.spring(duration: 0.3), value: model.toast)
    }

    private func applyLaunchTab() {
        switch model.launch.screen {
        case .review, .draft: tab = .review
        case .rules: tab = .rules
        case .settings, .key: tab = .settings
        case .inbox, .thread, .compose, .search, .folder, .signin, nil: tab = .mail
        }
    }

    private func unlock() async {
        guard model.appLockEnabled else { locked = false; return }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { locked = false; return }
        if (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock LOJO Mail")) == true {
            withAnimation { locked = false }
        }
    }
}

private struct LockView: View {
    var locked: Bool
    var unlock: () -> Void

    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThickMaterial).ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "lock.fill").font(.system(size: 44)).foregroundStyle(Theme.accent)
                Text("LOJO Mail is locked").font(.title3.weight(.semibold))
                if locked {
                    Button("Unlock", action: unlock).buttonStyle(.borderedProminent)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}
