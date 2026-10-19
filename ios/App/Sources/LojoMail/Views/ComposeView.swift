import LojoMailCore
import PhotosUI
import SwiftUI

/// Compose, reply, forward, and review of any draft (Jon's, SI's, an assistant's, a rule's, or one saved by his desktop mail client).
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
    @State private var pickPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickFiles = false
    @State private var takePhoto = false
    @FocusState private var focus: ComposeField?
    @Environment(\.dynamicTypeSize) private var typeSize

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
            if let model { Task { await model.refreshCapabilities() } }
            if app.launch.composeSamples, let model, !model.hasAttachments, case .new = request {
                for sample in AttachmentImport.samples() { model.attach(sample) }
            }
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
                        Chip(text: draft.origin.chip, systemImage: draft.origin.isBot ? "sparkles" : "person", tint: draft.origin.isBot ? Theme.si : Theme.accent)
                        if draft.aiGenerated == true && draft.origin != .ai { Chip(text: "SI text", systemImage: "sparkles", tint: Theme.si) }
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
                Section { HStack { ProgressView(); Text("SI is writing a reply…").foregroundStyle(.secondary) } }
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
                LabeledContent(ComposeChrome.toLabel) {
                    TextField("name@example.com", text: $model.fields.to, axis: .vertical)
                        .font(.body)
                        .focused($focus, equals: .to)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.emailAddress)
                        .accessibilityLabel(ComposeChrome.toLabel)
                }
                LabeledContent(ComposeChrome.ccLabel) {
                    TextField("Optional", text: $model.fields.cc, axis: .vertical)
                        .font(.body)
                        .focused($focus, equals: .cc)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel(ComposeChrome.ccLabel)
                }
                LabeledContent(ComposeChrome.subjectLabel) {
                    TextField("Subject", text: $model.fields.subject, axis: .vertical)
                        .font(.body)
                        .focused($focus, equals: .subject)
                        .accessibilityLabel(ComposeChrome.subjectLabel)
                }
            } header: {
                Text("Recipients").textCase(nil)
            }
            .disabled(model.closed)
            Section {
                ZStack(alignment: .topLeading) {
                    if model.fields.text.isEmpty {
                        Text(ComposeChrome.placeholder)
                            .font(.body)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 8)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                    TextEditor(text: $model.fields.text)
                        .font(.body)
                        .lineSpacing(CGFloat(ComposeChrome.bodyLineSpacing))
                        .focused($focus, equals: .body)
                        .frame(minHeight: CGFloat(ComposeChrome.editorMinHeight(accessibilitySize: typeSize.isAccessibilitySize)))
                        .accessibilityLabel(ComposeChrome.messageLabel)
                        .disabled(model.closed)
                }
            } header: {
                Text(ComposeChrome.messageLabel).textCase(nil)
            } footer: {
                Text(ComposeChrome.approvalNote)
            }
            if !model.closed || model.hasAttachments {
                ComposeAttachmentsSection(model: model, photos: openPhotos, camera: openCamera, files: openFiles)
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
                    Label("Stop all sending is on in Rules, so the server will refuse to send. You can still save to the approval queue.", systemImage: "xmark.octagon.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            if app.sendTestMode {
                Section {
                    Label(model.blockedByTestMode.isEmpty
                        ? "Test mode is on. Sending is limited to \(AppModel.testAddress)."
                        : "Test mode is on. Sending is limited to \(AppModel.testAddress); \(model.blockedByTestMode.joined(separator: ", ")) would be refused.",
                        systemImage: "testtube.2")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                    Button("Turn off test mode") { app.sendTestMode = false }
                        .accessibilityIdentifier("testmode.off")
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
                    .disabled(!canSend(model) || app.rules?.rules.sendKillSwitch == true)
                    .accessibilityHint("Asks you to confirm before sending")
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                } footer: {
                    if model.overBudget {
                        Text("Remove an attachment to send: the message is over \(ByteSize.format(model.budget.maxMessageBytes)).").foregroundStyle(.red)
                    } else {
                        Text("Sending asks the server for a one-time approval bound to exactly the recipients, subject, text\(model.hasAttachments ? ", attachments" : "") and encryption shown here. Only you can do this step; bots and other clients can't.")
                    }
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .toolbar { keyboardFields }
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
            Text("This sends real email from \(app.mailbox)\(model.fields.pgp == .off ? " in plain text" : ""). Subject: \(model.fields.subject.isEmpty ? "(none)" : model.fields.subject)\(attachmentSummary(model))")
        }
        .photosPicker(isPresented: $pickPhotos, selection: $photoItems, maxSelectionCount: max(1, model.budget.maxFiles - model.serverAttachments.count - model.attachments.count), matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await addPhotos(items, to: model) }
        }
        .fileImporter(isPresented: $pickFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): addFiles(urls, to: model)
            case .failure(let failure): model.attachmentNotice = failure.localizedDescription
            }
        }
        .fullScreenCover(isPresented: $takePhoto) {
            CameraPicker { image in addCameraPhoto(image, to: model) }
                .ignoresSafeArea()
        }
        .confirmationDialog("Keep this draft?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Save draft") { Task { await model.saveDraft(); if model.error == nil { dismiss() } } }
            Button("Save to approval queue") { Task { await model.saveToApprovalQueue(); if model.error == nil { dismiss() } } }
            Button("Close without saving", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: {
            if model.hasAttachments {
                Text("Saving uploads the attachments to the draft with the text.")
            }
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
        .alert("Rewrite with SI", isPresented: $askCustom) {
            TextField("Instruction", text: $customInstruction)
            Button("Rewrite") { Task { await model.rewrite(customInstruction) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("SI rewrites the draft. It stays a draft until you approve it.")
        }
    }

    @ToolbarContentBuilder
    private var keyboardFields: some ToolbarContent {
        ToolbarItemGroup(placement: .keyboard) {
            Button {
                focus = ComposeChrome.previousField(focus)
            } label: {
                Image(systemName: "chevron.up")
            }
            .disabled(ComposeChrome.previousField(focus) == nil)
            .accessibilityLabel("Previous field")
            .accessibilityIdentifier("compose.field.previous")
            Button {
                focus = ComposeChrome.nextField(focus)
            } label: {
                Image(systemName: "chevron.down")
            }
            .disabled(ComposeChrome.nextField(focus) == nil)
            .accessibilityLabel("Next field")
            .accessibilityIdentifier("compose.field.next")
            Spacer()
            Button("Done") { focus = nil }
                .accessibilityIdentifier("compose.field.done")
        }
    }

    @ToolbarContentBuilder
    private func toolbar(_ model: ComposeModel) -> some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(model.closed ? "Done" : (presentedAsSheet ? "Cancel" : "Close")) {
                if model.dirty && !model.closed { confirmClose = true } else { dismiss() }
            }
            .accessibilityIdentifier("compose.cancel")
        }
        if !model.closed {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    focus = nil
                    confirmSend = true
                } label: {
                    Image(systemName: "paperplane.fill")
                }
                .disabled(!canSend(model))
                .accessibilityLabel("Approve and send")
                .accessibilityHint("Asks you to confirm before sending")
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    AttachMenuItems(photos: openPhotos, camera: openCamera, files: openFiles)
                } label: {
                    Image(systemName: "paperclip")
                }
                .accessibilityLabel("Add attachment")
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
                        Label("Rewrite with SI", systemImage: "sparkles")
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

    private func canSend(_ model: ComposeModel) -> Bool {
        !model.busy && !model.fields.toList.isEmpty && model.conflictArmed && model.blockedByTestMode.isEmpty
            && !model.overBudget && model.loadingAttachments == 0
    }

    private func attachmentSummary(_ model: ComposeModel) -> String {
        let count = model.serverAttachments.count + model.attachments.count
        guard count > 0 else { return "" }
        return ". \(count == 1 ? "1 attachment" : "\(count) attachments"), \(ByteSize.format(model.attachedBytes))."
    }

    private func openPhotos() { focus = nil; pickPhotos = true }
    private func openCamera() { focus = nil; takePhoto = true }
    private func openFiles() { focus = nil; pickFiles = true }

    private func addPhotos(_ items: [PhotosPickerItem], to model: ComposeModel) async {
        model.loadingAttachments += items.count
        let start = model.attachments.count + model.serverAttachments.count
        for (offset, item) in items.enumerated() {
            defer { model.loadingAttachments -= 1 }
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                let name = AttachmentImport.photoName(start + offset + 1)
                let room = model.roomLeft
                let file = try await Task.detached(priority: .userInitiated) { try AttachmentImport.photo(data, name: name, room: room) }.value
                model.attach(file)
            } catch {
                model.attachmentNotice = error.localizedDescription
            }
        }
    }

    private func addCameraPhoto(_ image: UIImage, to model: ComposeModel) {
        let name = AttachmentImport.photoName(model.attachments.count + model.serverAttachments.count + 1)
        do {
            model.attach(try AttachmentImport.photo(image, name: name, room: model.roomLeft))
        } catch {
            model.attachmentNotice = error.localizedDescription
        }
    }

    private func addFiles(_ urls: [URL], to model: ComposeModel) {
        for url in urls {
            do {
                model.attach(try AttachmentImport.file(at: url, room: model.roomLeft))
            } catch {
                model.attachmentNotice = error.localizedDescription
            }
        }
    }

    private func title(_ model: ComposeModel) -> String {
        if let draft = model.draft, draft.origin.isBot { return "Review draft" }
        switch request {
        case .new: return "New message"
        case .reply(_, let all): return all ? "Reply all" : "Reply"
        case .forward: return "Forward"
        case .aiReply: return "Reply with SI"
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
