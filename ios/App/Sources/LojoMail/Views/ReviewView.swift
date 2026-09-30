import LojoMailCore
import SwiftUI

/// The approval queue: drafts from the AI, assistants, rules and Thunderbird, plus Jon's own.
struct ReviewView: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()
    @State private var showDone = false
    @State private var appliedLaunch = false

    private var open: [DraftView] { model.drafts.filter { $0.draft.status.editable } }
    private var waiting: [DraftView] { open.filter { $0.draft.status == .pendingApproval } }
    private var bots: [DraftView] { open.filter { $0.draft.status != .pendingApproval && $0.draft.origin.isBot } }
    private var mine: [DraftView] { open.filter { $0.draft.status != .pendingApproval && !$0.draft.origin.isBot } }
    private var done: [DraftView] { model.drafts.filter { !$0.draft.status.editable } }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if !model.online {
                    Banner(text: "Offline", systemImage: "wifi.slash", tint: .orange).listRowSeparator(.hidden)
                }
                section("Waiting for your approval", waiting, systemImage: "hourglass")
                section("Written by AI and assistants", bots, systemImage: "sparkles")
                section("Your drafts", mine, systemImage: "doc")
                if !done.isEmpty {
                    Section {
                        DisclosureGroup("Sent and discarded (\(done.count))", isExpanded: $showDone) {
                            ForEach(done) { view in row(view) }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Review")
            .navigationDestination(for: DraftView.self) { view in
                ComposeView(request: .draft(view), presentedAsSheet: false)
            }
            .refreshable { await model.refreshDrafts() }
            .overlay {
                if model.drafts.isEmpty {
                    if model.draftsLoading {
                        ProgressView()
                    } else if let error = model.draftsError {
                        StateView(title: "Couldn't load drafts", systemImage: "exclamationmark.icloud", message: error, actionTitle: "Try again") {
                            Task { await model.refreshDrafts() }
                        }
                    } else {
                        StateView(
                            title: "Nothing to review",
                            systemImage: "checkmark.seal",
                            message: "Drafts the AI, your assistants, your mail rules or Thunderbird write land here. Nothing they write is sent until you open it here and tap Approve and send."
                        )
                    }
                }
            }
            .task {
                await model.refreshDrafts()
                applyLaunch()
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ items: [DraftView], systemImage: String) -> some View {
        if !items.isEmpty {
            Section {
                ForEach(items) { view in
                    row(view)
                        .swipeActions {
                            Button(role: .destructive) {
                                Task {
                                    _ = try? await model.call { try await $0.discard(view.id) }
                                    await model.refreshDrafts()
                                }
                            } label: { Label("Discard", systemImage: "trash") }
                        }
                }
            } header: {
                Label("\(title) (\(items.count))", systemImage: systemImage)
            }
        }
    }

    private func row(_ view: DraftView) -> some View {
        NavigationLink(value: view) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Chip(text: view.draft.origin.chip, systemImage: view.draft.origin.isBot ? "sparkles" : "person", tint: view.draft.origin.isBot ? Theme.ai : Theme.accent)
                    Chip(text: view.draft.status.label, tint: view.draft.status == .pendingApproval ? .orange : .secondary)
                    Spacer()
                    Text(ISODate.parse(view.draft.updatedAt)?.mailListStamp ?? "").font(.caption).foregroundStyle(.secondary)
                }
                Text("To: \(view.draft.to.map(\.email).joined(separator: ", "))").font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(view.draft.subject.isEmpty ? "(no subject)" : view.draft.subject).font(.subheadline).lineLimit(1)
                if let text = view.text?.nonEmptyTrimmed {
                    Text(text).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
        }
    }

    private func applyLaunch() {
        guard !appliedLaunch else { return }
        appliedLaunch = true
        guard model.launch.screen == .draft else { return }
        let target = model.launch.draft.flatMap { id in model.drafts.first { $0.id == id } } ?? open.first
        if let target { path.append(target) }
    }
}

struct RulesView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmRelease = false
    @State private var confirmResume = false
    @State private var working = false

    private var doc: RulesDocument? { model.rules?.rules }
    private var serverAllows: Bool { model.rules?.autoSendEnabled ?? false }
    private var armedRules: [Rule] { (doc?.rules ?? []).filter { $0.enabled && $0.autoSends } }

    var body: some View {
        NavigationStack {
            List {
                if let doc {
                    Section { killSwitchCard(doc) }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    Section {
                        Toggle(isOn: Binding(get: { !doc.paused }, set: { on in
                            if on { confirmResume = true } else { Task { await model.setPaused(true) } }
                        })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Rules engine")
                                Text(doc.paused ? "Paused: no rule runs on new mail." : "Running on every new message.").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    } footer: {
                        Text("Pausing is always allowed; only your signed-in session can resume.")
                    }
                    Section("Rules (\(doc.rules.count))") {
                        if doc.rules.isEmpty {
                            Text("No rules yet. Rules are written as JSON on your desktop (`npm run rules -- push`), which signs in as you.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(doc.rules) { rule in
                            ruleRow(rule)
                                .swipeActions {
                                    if rule.enabled {
                                        Button("Disable") { Task { await model.disableRule(rule.id) } }.tint(.orange)
                                    }
                                }
                        }
                    }
                    Section {
                        LabeledContent("Trash retention", value: "\(doc.trashRetentionDays ?? 30) days")
                        LabeledContent("Auto-send limit", value: "\(doc.maxAutoSendPerDay ?? 0) per day")
                        if let updated = doc.updatedAt.flatMap(ISODate.parse) {
                            LabeledContent("Last change", value: "\(updated.formatted(date: .abbreviated, time: .shortened)) by \(doc.updatedBy == "human" ? "you" : doc.updatedBy ?? "?")")
                        }
                    }
                }
            }
            .navigationTitle("AI Rules")
            .refreshable { await model.refreshRules() }
            .overlay {
                if doc == nil {
                    if let error = model.rulesError {
                        StateView(title: "Couldn't load rules", systemImage: "exclamationmark.icloud", message: error, actionTitle: "Try again") {
                            Task { await model.refreshRules() }
                        }
                    } else {
                        ProgressView()
                    }
                }
            }
            .task { await model.refreshRules() }
            .confirmationDialog("Release the kill switch?", isPresented: $confirmRelease, titleVisibility: .visible) {
                Button("Release kill switch", role: .destructive) { Task { await model.setKillSwitch(false) } }
            } message: {
                Text(serverAllows
                    ? "Auto-send rules you wrote (\(armedRules.count) enabled) may send replies on their own again, within their allowlists and limits."
                    : "The server has auto-send turned off, so rules still only write drafts.")
            }
            .confirmationDialog("Resume all rules?", isPresented: $confirmResume, titleVisibility: .visible) {
                Button("Resume rules") { Task { await model.setPaused(false) } }
            }
        }
    }

    private func killSwitchCard(_ doc: RulesDocument) -> some View {
        let stopped = doc.killSwitch || !serverAllows
        let tint: Color = stopped ? .green : .orange
        let headline: String = {
            if doc.killSwitch { return "Autonomous sending is stopped" }
            if !serverAllows { return "Autonomous sending is off at the server" }
            return armedRules.isEmpty ? "Autonomous sending is allowed" : "Armed: \(armedRules.count) auto-send rule\(armedRules.count == 1 ? "" : "s")"
        }()
        let detail: String = {
            if !serverAllows { return "The deployment has auto_send_enabled off. Rules and bots can only write drafts for you to approve." + (doc.killSwitch ? " The kill switch is also engaged." : "") }
            if doc.killSwitch { return "Every reply falls back to a draft for your approval until you release it." }
            return "Auto-send rules may reply on their own, fenced by allowlists, DMARC, loop checks and rate limits."
        }()
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: stopped ? "hand.raised.fill" : "exclamationmark.triangle.fill")
                    .font(.title)
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 3) {
                    Text(headline).font(.headline)
                    Text(detail).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if doc.killSwitch {
                Button { confirmRelease = true } label: {
                    Text("Release kill switch").frame(maxWidth: .infinity).padding(.vertical, 6)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            } else {
                Button {
                    Haptics.warning()
                    Task { await model.setKillSwitch(true) }
                } label: {
                    Label("Stop all autonomous sending", systemImage: "hand.raised.fill")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .controlSize(.large)
                .accessibilityHint("Engages the kill switch. Replies fall back to drafts.")
            }
        }
        .padding(16)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func ruleRow(_ rule: Rule) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(rule.name).font(.body.weight(.semibold))
                Spacer()
                Chip(text: rule.enabled ? "On" : "Off", tint: rule.enabled ? .green : .secondary)
            }
            Text(rule.actions.map(\.summary).joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary)
            HStack(spacing: 5) {
                if rule.autoSends { Chip(text: "Auto-send", systemImage: "paperplane", tint: .orange) }
                if rule.createdBy == "human" { Chip(text: "Written by you", systemImage: "person", tint: Theme.accent) }
                if rule.stop == true { Chip(text: "Stops later rules", tint: .secondary) }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
