import LojoMailCore
import SwiftUI

struct SiFilterRequest: Identifiable, Equatable {
    var messageIds: [String]
    var folder: String?
    var texts: [String: String]

    var id: String { (folder ?? "") + messageIds.joined(separator: ",") }
}

/// Proposed filing actions. Apply-all or one row. Nothing is deleted permanently.
struct SiFilterView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var request: SiFilterRequest

    @State private var screen: SiFilterScreen?
    @State private var loading = true
    @State private var error: String?
    @State private var applying = false

    var body: some View {
        Group {
            if loading {
                ProgressView("SI is reading the mail…")
            } else if let error, screen == nil {
                StateView(title: "SI couldn't filter", systemImage: "sparkles", message: error, actionTitle: "Try again") {
                    Task { await load() }
                }
            } else if let screen {
                proposals(screen)
            }
        }
        .navigationTitle("Filter with SI")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Apply all") { Task { await apply(screen?.applyAll ?? []) } }
                    .disabled(!(screen?.canApply ?? false) || applying)
                    .accessibilityIdentifier("si.apply-all")
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func proposals(_ screen: SiFilterScreen) -> some View {
        List {
            if screen.killSwitch {
                Banner(text: "SI filters are stopped. Release the switch in Settings to apply anything.", systemImage: "hand.raised.fill", tint: .orange)
                    .listRowSeparator(.hidden)
            }
            Section {
                Text("Trash stays recoverable. A block can be undone from Blocked. Apply all uses the checked rows.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if screen.proposals.isEmpty {
                Text("Nothing to filter.")
            }
            ForEach(screen.proposals) { proposal in
                row(proposal, screen: screen)
            }
        }
        .accessibilityIdentifier("si.filter.list")
    }

    private func row(_ proposal: SiProposal, screen: SiFilterScreen) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Button {
                    var next = screen
                    next.toggle(proposal.messageId)
                    self.screen = next
                } label: {
                    Image(systemName: screen.selected.contains(proposal.messageId) ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(screen.selected.contains(proposal.messageId) ? "Included" : "Not included")
                VStack(alignment: .leading, spacing: 2) {
                    Text(proposal.subject.nonEmptyTrimmed ?? "(no subject)").font(.body.weight(.semibold))
                    Text(proposal.from).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if !proposal.reason.isEmpty {
                Text(proposal.reason).font(.subheadline)
            }
            if proposal.safeActions.isEmpty {
                Text("SI would leave this.").font(.subheadline).foregroundStyle(.secondary)
            } else {
                ForEach(Array(proposal.safeActions.enumerated()), id: \.offset) { _, action in
                    Label(action.summary(from: proposal.from, domain: proposal.domain), systemImage: icon(action))
                        .font(.subheadline)
                }
                Toggle("Use this for new mail", isOn: Binding(
                    get: { proposal.saveRule },
                    set: { on in
                        var next = screen
                        next.setSaveRule(proposal.messageId, on)
                        self.screen = next
                    }
                ))
                .font(.subheadline)
                Button("Apply") { Task { await apply(screen.applyOne(proposal.messageId)) } }
                    .disabled(screen.killSwitch || applying)
                    .accessibilityIdentifier("si.apply.\(proposal.messageId)")
            }
        }
        .padding(.vertical, 4)
    }

    private func icon(_ action: SiAction) -> String {
        switch action.type {
        case "label": "folder"
        case "spam": "xmark.bin"
        case "trash": "trash"
        case "blockSender", "blockDomain": "hand.raised"
        default: "sparkles"
        }
    }

    private func load() async {
        loading = screen == nil
        error = nil
        do {
            let result = try await model.call { try await $0.siFilter(messageIds: request.messageIds, folder: request.folder, texts: request.texts) }
            screen = SiFilterScreen(result: result)
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func apply(_ items: [SiProposal]) async {
        guard !items.isEmpty else { return }
        applying = true
        defer { applying = false }
        do {
            let result = try await model.call { try await $0.siApply(items) }
            guard result.undo else { return }
            for folder in Folder.allCases { await model.refresh(folder) }
            await model.refreshRules()
            model.toast = Toast(
                text: result.applied == 1 ? "SI filtered 1 message" : "SI filtered \(result.applied) messages",
                systemImage: "line.3.horizontal.decrease.circle.fill",
                undo: .siChange(result.changeId)
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
            model.report(error)
        }
    }
}

struct BlockedSendersView: View {
    @Environment(AppModel.self) private var model
    @State private var blocked: [SiBlock] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if blocked.isEmpty && !loading {
                Text("No blocked senders or domains. SI can block one from Filter with SI. New mail from a block goes to Trash, and you can restore it.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(blocked) { block in
                HStack {
                    VStack(alignment: .leading) {
                        Text(block.title)
                        Text(block.kind == "domain" ? "Domain" : "Sender").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Unblock") { Task { await unblock(block) } }
                        .accessibilityIdentifier("si.unblock.\(block.ruleId)")
                }
            }
        }
        .navigationTitle("Blocked")
        .overlay { if loading { ProgressView() } }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        loading = blocked.isEmpty
        do {
            blocked = try await model.call { try await $0.siBlocked() }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func unblock(_ block: SiBlock) async {
        do {
            if let changeId = try await model.call({ try await $0.siUnblock(block.ruleId) }) {
                model.toast = Toast(text: "Unblocked \(block.title)", systemImage: "hand.raised.slash", undo: .siChange(changeId))
            }
            await model.refreshRules()
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct SiRulesView: View {
    @Environment(AppModel.self) private var model

    private var rules: [Rule] {
        (model.rules?.rules.rules ?? []).filter { $0.isSiRule && !$0.isSiBlock }
    }

    var body: some View {
        List {
            Section {
                Text("These run on new mail. Trash is kept for \(model.rules?.rules.trashRetentionDays ?? 30) days. Stop SI filters in Settings pauses all of them.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if rules.isEmpty {
                Text("No saved SI filters yet. On a proposal, turn on “Use this for new mail”.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(rules) { rule in
                VStack(alignment: .leading, spacing: 6) {
                    Text(rule.name).font(.body.weight(.semibold))
                    Text(rule.enabled ? "On for new mail" : "Off").font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(rule.actions.enumerated()), id: \.offset) { _, action in
                        Text(action.summary).font(.subheadline)
                    }
                    if rule.enabled {
                        Button("Turn off") { Task { await model.disableRule(rule.id) } }
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .navigationTitle("SI filters")
        .task { await model.refreshRules() }
    }
}
