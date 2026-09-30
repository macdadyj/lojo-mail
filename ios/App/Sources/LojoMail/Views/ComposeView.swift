import LojoMailCore
import SwiftUI

/// Compose, reply, forward, and review of any draft (Jon's, the AI's, an assistant's, a rule's or Thunderbird's).
struct ComposeView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let request: ComposeRequest
    var presentedAsSheet: Bool

    @State private var model: ComposeModel?
    @State private var confirmSend = false
    @State private var confirmClose = false
    @State private var confirmDiscard = false
    @State private var customInstruction = ""
    @State private var askCustom = false
    @FocusState private var focus: Field?

    enum Field { case to, cc, subject, body }

    var body: some View {
        Group {
            if let model {
                form(model)
            } else {
                ProgressView()
            }
        }
        .onAppear {
            if model == nil { model = ComposeModel(model: app, request: request) }
            if app.launch.screen == .sendconfirm, let model, !model.fields.toList.isEmpty {
                if model.fields.subject.isEmpty { model.fields.subject = "LOJO Mail iOS test" }
                confirmSend = true
            }
        }
    }

    @ViewBuilder
    private func form(_ model: ComposeModel) -> some View {
        @Bindable var model = model
        Form {
            if let draft = model.draft {
                Section {
                    HStack(spacing: 6) {
                        Chip(text: draft.status.label, systemImage: draft.status == .pendingApproval ? "hourglass" : "doc", tint: draft.status == .pendingApproval ? .orange : .secondary)
                        Chip(text: draft.origin.chip, systemImage: draft.origin.isBot ? "sparkles" : "person", tint: draft.origin.isBot ? Theme.ai : Theme.accent)
                        if draft.aiGenerated == true && draft.origin != .ai { Chip(text: "AI text", systemImage: "sparkles", tint: Theme.ai) }
                        Spacer()
                        if let updated = ISODate.parse(draft.updatedAt) {
                            Text(updated.mailListStamp).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let notice = draft.authorNotice {
                        Label(notice, systemImage: "person.badge.shield.checkmark").font(.footnote).foregroundStyle(.orange)
                    }
                }
            }
            if model.preparing {
                Section { HStack { ProgressView(); Text("The AI is drafting a reply…").foregroundStyle(.secondary) } }
            }
            if let conflict = model.conflict {
                Section {
                    Label(
                        "This draft changed after you opened it. Nothing was approved or sent.\(conflict.isEmpty ? "" : " Changed: \(conflict.joined(separator: ", ")).") Read the current version below before you approve it.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.footnote)
                    .foregroundStyle(.orange)
                }
            }
            Section {
                LabeledContent("To") {
                    TextField("name@example.com", text: $model.fields.to, axis: .vertical)
                        .focused($focus, equals: .to)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.emailAddress)
                }
                LabeledContent("Cc") {
                    TextField("", text: $model.fields.cc, axis: .vertical)
                        .focused($focus, equals: .cc)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                LabeledContent("Subject") {
                    TextField("", text: $model.fields.subject, axis: .vertical)
                        .focused($focus, equals: .subject)
                }
            }
            .disabled(model.closed)
            Section {
                TextEditor(text: $model.fields.text)
                    .focused($focus, equals: .body)
                    .frame(minHeight: 260)
                    .accessibilityLabel("Message")
                    .disabled(model.closed)
            } footer: {
                if let warning = model.forwardWarning { Text(warning) }
            }
            Section {
                Picker("Encryption", selection: $model.fields.pgp) {
                    Text("OpenPGP when possible").tag(PgpMode.auto)
                    Text("Off (plain text)").tag(PgpMode.off)
                }
                .disabled(model.closed)
            } footer: {
                Text(model.fields.pgp == .off
                    ? "Encryption is off. This goes out in plain text, even to recipients who have an OpenPGP key."
                    : "Encrypted with OpenPGP when every recipient has a published key; otherwise sent over TLS.")
            }
            if app.rules?.rules.sendKillSwitch == true {
                Section {
                    Label("Stop all sending is on in AI Rules, so the server will refuse to send. You can still save to the approval queue.", systemImage: "xmark.octagon.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            if !model.blockedByTestMode.isEmpty {
                Section {
                    Label("Test mode is on. Sending is limited to \(AppModel.testAddress); \(model.blockedByTestMode.joined(separator: ", ")) would be refused. Save to the approval queue instead, or turn test mode off in Settings.", systemImage: "testtube.2")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
            if let status = model.status {
                Section { Label(status, systemImage: model.sentMessageId == nil ? "checkmark.circle" : "paperplane.fill").foregroundStyle(.green) }
            }
            if let error = model.error {
                Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
            }
            if !model.closed {
                Section {
                    Button {
                        focus = nil
                        confirmSend = true
                    } label: {
                        Label(model.conflict != nil ? (model.conflictArmed ? "Approve this version and send" : "Read the changes first…") : "Approve and send", systemImage: "paperplane.fill")
                            .frame(maxWidth: .infinity)
                            .fontWeight(.semibold)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(model.busy || model.fields.toList.isEmpty || !model.conflictArmed || !model.blockedByTestMode.isEmpty || app.rules?.rules.sendKillSwitch == true)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                } footer: {
                    Text("Sending asks the server for a one-time approval bound to exactly the recipients, subject, text and encryption shown here. Bots and Thunderbird can't do this step.")
                }
            }
        }
        .navigationTitle(title(model))
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(model.dirty && !model.closed)
        .toolbar { toolbar(model) }
        .overlay { if model.busy { ProgressView().controlSize(.large).padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) } }
        .confirmationDialog(sendQuestion(model), isPresented: $confirmSend, titleVisibility: .visible) {
            Button("Send now") {
                Task {
                    await model.approveAndSend()
                    if model.sentMessageId != nil {
                        Haptics.success()
                        app.toast = Toast(text: "Sent", systemImage: "paperplane.fill")
                        await app.refreshDrafts()
                        dismiss()
                    } else {
                        Haptics.warning()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This sends real email from \(app.mailbox)\(model.fields.pgp == .off ? " in plain text" : ""). Subject: \(model.fields.subject.isEmpty ? "(none)" : model.fields.subject)")
        }
        .confirmationDialog("Keep this draft?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Save draft") { Task { await model.saveDraft(); if model.error == nil { dismiss() } } }
            Button("Save to approval queue") { Task { await model.saveToApprovalQueue(); if model.error == nil { dismiss() } } }
            Button("Close without saving", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .confirmationDialog("Discard this draft?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard draft", role: .destructive) {
                Task {
                    if await model.discard() {
                        await app.refreshDrafts()
                        dismiss()
                    }
                }
            }
        } message: {
            Text("It is marked discarded on the server and leaves the approval queue.")
        }
        .alert("Rewrite with AI", isPresented: $askCustom) {
            TextField("Instruction", text: $customInstruction)
            Button("Rewrite") { Task { await model.rewrite(customInstruction) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The AI rewrites the draft. It stays a draft until you approve it.")
        }
    }

    @ToolbarContentBuilder
    private func toolbar(_ model: ComposeModel) -> some ToolbarContent {
        if presentedAsSheet {
            ToolbarItem(placement: .cancellationAction) {
                Button(model.closed ? "Done" : "Cancel") {
                    if model.dirty && !model.closed { confirmClose = true } else { dismiss() }
                }
            }
        }
        if !model.closed {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    focus = nil
                    confirmSend = true
                } label: {
                    Image(systemName: "paperplane.fill")
                }
                .disabled(model.busy || model.fields.toList.isEmpty || !model.conflictArmed || !model.blockedByTestMode.isEmpty)
                .accessibilityLabel("Approve and send")
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { Task { await model.saveDraft() } } label: { Label("Save draft", systemImage: "square.and.arrow.down") }
                    Button { Task { await model.saveToApprovalQueue() } } label: { Label("Save to approval queue", systemImage: "tray.and.arrow.down") }
                    Menu {
                        ForEach(["Make it shorter.", "Make it friendlier.", "Make it more formal.", "Fix grammar and spelling only."], id: \.self) { instruction in
                            Button(instruction) { Task { await model.rewrite(instruction) } }
                        }
                        Button("Custom…") { askCustom = true }
                    } label: {
                        Label("Rewrite with AI", systemImage: "sparkles")
                    }
                    if model.draft != nil {
                        Divider()
                        Button(role: .destructive) { confirmDiscard = true } label: { Label("Discard draft", systemImage: "trash") }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Draft actions")
            }
        }
    }

    private func title(_ model: ComposeModel) -> String {
        if let draft = model.draft, draft.origin.isBot { return "Review draft" }
        switch request {
        case .new: return "New message"
        case .reply(_, let all): return all ? "Reply all" : "Reply"
        case .forward: return "Forward"
        case .aiReply: return "AI reply"
        case .draft: return model.closed ? "Draft" : "Edit draft"
        }
    }

    private func sendQuestion(_ model: ComposeModel) -> String {
        let recipients = model.fields.allRecipients
        let shown = recipients.prefix(3).joined(separator: ", ")
        let more = recipients.count > 3 ? " and \(recipients.count - 3) more" : ""
        return "Send to \(shown)\(more)?"
    }
}
