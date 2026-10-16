import LojoMailCore
import SwiftUI

struct SiMessageFilterRequest: Identifiable, Equatable {
    var messageIds: [String]
    var from: String
    var domain: String
    var subject: String
    var texts: [String: String]

    var id: String { messageIds.joined(separator: ",") + "|" + from }
}

/// Direct choices for one sender. "Let SI decide" pushes the proposal list.
struct SiMessageFilterView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var request: SiMessageFilterRequest

    @State private var filter: SiMessageFilter
    @State private var applying = false
    @State private var error: String?
    @State private var showDecide = false

    init(request: SiMessageFilterRequest, existingLabels: [String]) {
        self.request = request
        _filter = State(initialValue: SiMessageFilter(
            messageIds: request.messageIds,
            from: request.from,
            domain: request.domain,
            subject: request.subject,
            existingLabels: existingLabels
        ))
    }

    var body: some View {
        List {
            if filter.killSwitch {
                Banner(text: "SI filters are stopped. Release the switch in Settings to apply anything.", systemImage: "hand.raised.fill", tint: .orange)
                    .listRowSeparator(.hidden)
            }
            Section {
                VStack(alignment: .leading, spacing: 2) {
                    Text(request.subject.nonEmptyTrimmed ?? "(no subject)").font(.body.weight(.semibold))
                    Text(filter.from).font(.footnote).foregroundStyle(.secondary)
                }
                Toggle(SiEntry.futureMail, isOn: $filter.saveForFuture)
                    .disabled(filter.killSwitch || applying)
                    .accessibilityIdentifier("si.direct.future")
            }
            Section {
                choiceButton(.spam)
                labelChoice
                choiceButton(.blockSender)
                choiceButton(.trash)
                choiceButton(.decide)
            }
            Section {
                Text("Trash stays recoverable and can be undone. A block comes off from Blocked. Nothing is deleted permanently.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .navigationTitle(SiEntry.filterTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
        }
        .presentationDetents([.large])
        .navigationDestination(isPresented: $showDecide) {
            SiFilterView(request: SiFilterRequest(messageIds: request.messageIds, folder: nil, texts: request.texts))
        }
        .task { await loadSuggestion() }
        .accessibilityIdentifier("si.direct.sheet")
    }

    private var labelChoice: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(SiDirectChoice.label.title, systemImage: SiDirectChoice.label.systemImage)
                .font(.body)
                .accessibilityIdentifier("si.direct.label")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(filter.labelChips, id: \.self) { label in
                        chip(label, selected: !filter.makingNewLabel && filter.selectedLabel == label, suggested: filter.isSuggested(label)) {
                            filter.makingNewLabel = false
                            filter.selectedLabel = label
                        }
                    }
                    chip("New label", selected: filter.makingNewLabel, suggested: false) {
                        filter.makingNewLabel = true
                    }
                    .accessibilityIdentifier("si.direct.new-label")
                }
            }
            if filter.makingNewLabel {
                TextField("New label", text: $filter.customLabel)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("si.direct.label-field")
            }
            Button("Apply label") { Task { await apply(.label) } }
                .disabled(filter.killSwitch || applying || filter.resolvedLabel == nil)
                .accessibilityIdentifier("si.direct.apply-label")
        }
        .padding(.vertical, 4)
    }

    private func chip(_ title: String, selected: Bool, suggested: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 1) {
                Text(title == "New label" ? title : SiLabels.title(title)).font(.caption.weight(.semibold))
                if suggested { Text("SI suggests").font(.caption2) }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(selected ? Theme.si.opacity(0.18) : Color.secondary.opacity(0.12), in: Capsule())
            .foregroundStyle(selected ? Theme.si : .primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(suggested ? "\(SiLabels.title(title)), SI suggests" : (title == "New label" ? title : SiLabels.title(title)))
    }

    private func choiceButton(_ choice: SiDirectChoice) -> some View {
        Button { Task { await apply(choice) } } label: {
            Label(choice.title, systemImage: choice.systemImage)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .disabled((filter.killSwitch || applying) && choice != .decide)
        .accessibilityIdentifier("si.direct.\(choice.rawValue)")
    }

    private func loadSuggestion() async {
        if model.launch.uiTest {
            let result = UITestFixtures.filterResult()
            filter.killSwitch = result.killSwitch
            let suggested = result.proposals.lazy.compactMap { proposal in
                proposal.actions.first { $0.type == "label" }?.labels?.first
            }.first
            filter.useSuggestion(suggested)
            return
        }
        do {
            let result = try await model.call { try await $0.siFilter(messageIds: request.messageIds, folder: nil, texts: request.texts) }
            filter.killSwitch = result.killSwitch
            let suggested = result.proposals.lazy.compactMap { proposal in
                proposal.actions.first { $0.type == "label" }?.labels?.first
            }.first
            filter.useSuggestion(suggested)
        } catch {
            self.error = nil
        }
    }

    private func apply(_ choice: SiDirectChoice) async {
        if choice == .decide {
            showDecide = true
            return
        }
        if choice == .blockSender { filter.saveForFuture = true }
        let items = filter.proposals(for: choice)
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
                systemImage: "sparkles",
                undo: .siChange(result.changeId)
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
            model.report(error)
        }
    }
}
