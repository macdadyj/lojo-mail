import LojoMailCore
import QuickLook
import SwiftUI
import UIKit

struct ThreadView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var threadId: String
    var folder: Folder

    @State private var messages: [Message] = []
    @State private var loading = true
    @State private var error: String?
    @State private var expanded: Set<String> = []
    @State private var compose: ComposeRequest?
    @State private var preview: URL?
    @State private var sharing: SharedFile?
    @State private var saving: URL?
    @State private var opening: String?
    @State private var showKeySetup = false
    @State private var confirmTrash = false
    @State private var siReply = false
    @State private var siFilter: SiFilterRequest?
    @State private var pendingSiDraft: DraftView?

    private var latest: Message? { messages.last }
    private var replyTarget: Message? { messages.last(where: { $0.origin != "sent" }) ?? messages.last }
    private var starred: Bool { messages.contains(where: \.starred) }
    private var inTrash: Bool { messages.contains { $0.folder == Folder.trash.rawValue } }

    private var trashedByText: String {
        switch messages.compactMap(\.trashedBy).first {
        case "human": "Trashed by you"
        case "bridge": "Trashed from your mail client"
        case let actor? where actor.hasPrefix("agent:"): "Trashed by agent \(actor.dropFirst(6))"
        default: "In Trash"
        }
    }

    var body: some View {
        Group {
            if loading && messages.isEmpty {
                ProgressView("Opening…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error, messages.isEmpty {
                StateView(title: "Couldn't open this conversation", systemImage: "exclamationmark.bubble", message: error, actionTitle: "Try again") {
                    Task { await load() }
                }
            } else {
                content
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { topToolbar }
        .toolbar { bottomToolbar }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $compose) { request in
            NavigationStack { ComposeView(request: request, presentedAsSheet: true) }
        }
        .sheet(isPresented: $siReply, onDismiss: {
            if let pendingSiDraft {
                compose = .draft(pendingSiDraft)
                self.pendingSiDraft = nil
            }
        }) {
            NavigationStack {
                if let target = replyTarget {
                    SiReplyView(message: target, threadText: threadContext(except: target)) { pendingSiDraft = $0 }
                }
            }
        }
        .sheet(item: $siFilter) { request in
            NavigationStack { SiFilterView(request: request) }
        }
        .sheet(isPresented: $showKeySetup, onDismiss: { Task { await model.openBodies(messages) } }) { KeySetupView() }
        .quickLookPreview($preview)
        .onChange(of: preview) { old, new in
            if new == nil, let old { AttachmentFiles.remove(old) }
        }
        .sheet(item: $sharing, onDismiss: { AttachmentFiles.purge() }) { file in
            ActivitySheet(items: [file.url])
                .presentationDetents([.medium, .large])
                .ignoresSafeArea()
        }
        .fileMover(isPresented: Binding(get: { saving != nil }, set: { if !$0 { cleanUpSaving() } }), file: saving) { result in
            switch result {
            case .success: model.toast = Toast(text: "Saved to Files", systemImage: "folder")
            case .failure(let failure as CocoaError) where failure.code == .userCancelled: break
            case .failure(let failure): error = failure.localizedDescription
            }
            cleanUpSaving()
        }
    }

    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                Text(messages.first?.subject.nonEmptyTrimmed ?? "(no subject)")
                    .font(.title2.bold())
                    .textSelection(.enabled)
                    .accessibilityAddTraits(.isHeader)
                if inTrash, let keep = messages.compactMap(\.keepUntil).compactMap(ISODate.parse).min() {
                    Banner(text: "\(trashedByText) · kept until \(keep.formatted(date: .abbreviated, time: .omitted))", systemImage: "trash", tint: .secondary)
                }
                if let phish = messages.first(where: \.looksPhishy) { phishingCard(phish) }
                summaryCard
                ForEach(messages) { message in
                    MessageCard(
                        message: message,
                        bodyState: model.bodies[message.id],
                        text: model.bodyText(message),
                        parts: model.bodyParts(message),
                        linksOpenDirectly: model.linksOpenDirectly(message),
                        expanded: expanded.contains(message.id) || message.id == latest?.id,
                        opening: opening,
                        onToggle: { toggle(message) },
                        onUnlock: { showKeySetup = true },
                        onAttachment: { attachment, action in Task { await open(attachment, of: message, for: action) } }
                    )
                }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
                }
            }
            .padding()
            .readableWidth()
        }
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder
    private var summaryCard: some View {
        let opened = messages.compactMap { message -> SealedBody? in
            if case .opened(let body) = model.bodies[message.id] { return body }
            return nil
        }
        let summary = opened.compactMap { $0.ai?.threadSummary?.nonEmptyTrimmed }.last ?? opened.compactMap { $0.ai?.summary?.nonEmptyTrimmed }.last
        let items = opened.flatMap { $0.ai?.actionItems ?? [] }
        if let summary {
            VStack(alignment: .leading, spacing: 8) {
                Label("SI summary", systemImage: "sparkles").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ai)
                Text(summary).font(.subheadline)
                if !items.isEmpty {
                    ForEach(Array(Set(items.map(\.text))).sorted(), id: \.self) { item in
                        Label(item, systemImage: "checkmark.circle").font(.subheadline)
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.ai.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityElement(children: .combine)
        }
    }

    private func phishingCard(_ message: Message) -> some View {
        let reasons: [String] = {
            if case .opened(let body) = model.bodies[message.id] { return body.ai?.phishingReasons ?? [] }
            return []
        }()
        return VStack(alignment: .leading, spacing: 6) {
            Label("Possible phishing (score \(Int(message.phishingScore)))", systemImage: "exclamationmark.shield.fill")
                .font(.subheadline.weight(.semibold))
            Text(reasons.isEmpty ? "Don't open links or attachments unless you expected this." : reasons.joined(separator: " "))
                .font(.footnote)
        }
        .foregroundStyle(.red)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    @ToolbarContentBuilder
    private var topToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button {
                Task {
                    await model.setStar(messages, !starred)
                    await reloadQuietly()
                }
            } label: {
                Image(systemName: starred ? "star.fill" : "star").foregroundStyle(starred ? Theme.star : Color.accentColor)
            }
            .accessibilityLabel(starred ? "Unstar" : "Star")
            Menu {
                Button {
                    Task {
                        await model.setUnread(messages, true)
                        dismiss()
                    }
                } label: { Label("Mark as unread", systemImage: "envelope.badge") }
                Menu("Move to") {
                    ForEach(Folder.moveTargets.filter { $0.rawValue != latest?.folder }) { target in
                        Button {
                            Task {
                                await model.move(messages, from: folder, to: target)
                                dismiss()
                            }
                        } label: { Label(target.title, systemImage: target.systemImage) }
                    }
                }
                if replyTarget != nil {
                    Button { siReply = true } label: { Label("Reply with SI", systemImage: "sparkles") }
                        .accessibilityIdentifier("si.reply")
                    Button { filterThisThread() } label: { Label("Filter with SI", systemImage: "line.3.horizontal.decrease.circle") }
                        .accessibilityIdentifier("si.filter.message")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("More actions")
        }
    }

    @ToolbarContentBuilder
    private var bottomToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .bottomBar) {
            if inTrash {
                Button {
                    Task {
                        await model.restore(messages)
                        dismiss()
                    }
                } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
            } else {
                Button(role: .destructive) { confirmTrash = true } label: { Label("Trash", systemImage: "trash") }
                    .confirmationDialog("Move this conversation to Trash?", isPresented: $confirmTrash, titleVisibility: .visible) {
                        Button("Move to Trash", role: .destructive) {
                            Task {
                                await model.trash(messages, from: folder)
                                dismiss()
                            }
                        }
                    } message: {
                        Text("You can restore it from Trash for \(model.rules?.rules.trashRetentionDays ?? 30) days.")
                    }
                Spacer()
                if folder != .archive {
                    Button {
                        Task {
                            await model.archive(messages, from: folder)
                            dismiss()
                        }
                    } label: { Label("Archive", systemImage: "archivebox") }
                    Spacer()
                }
            }
            if let target = replyTarget {
                Spacer()
                Menu {
                    Button { compose = .reply(target, all: false) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                    Button { compose = .reply(target, all: true) } label: { Label("Reply All", systemImage: "arrowshape.turn.up.left.2") }
                    Button { compose = .forward(latest ?? target) } label: { Label("Forward", systemImage: "arrowshape.turn.up.right") }
                    Button { siReply = true } label: { Label("Reply with SI", systemImage: "sparkles") }
                        .accessibilityIdentifier("si.reply")
                } label: {
                    Label("Reply", systemImage: "arrowshape.turn.up.left")
                } primaryAction: {
                    compose = .reply(target, all: false)
                }
                .accessibilityLabel("Reply")
                .accessibilityHint("Hold for Reply All, Forward and Reply with SI")
            }
        }
    }

    private func threadContext(except target: Message) -> String {
        messages.filter { $0.id != target.id }.compactMap { message -> String? in
            guard let text = model.bodyText(message), !text.isEmpty else { return nil }
            return "From: \(message.from.email)\nSubject: \(message.subject)\n\(text)"
        }.joined(separator: "\n\n")
    }

    private func filterThisThread() {
        siFilter = SiFilterRequest(messageIds: messages.map(\.id), folder: nil, texts: model.siTexts(for: messages))
    }

    private func toggle(_ message: Message) {
        if expanded.contains(message.id) { expanded.remove(message.id) } else { expanded.insert(message.id) }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            messages = try await model.loadThread(threadId)
            error = nil
            if let unread = messages.first(where: \.unread) { expanded.insert(unread.id) }
            if model.launch.screen == .attachment, preview == nil,
               let message = messages.last(where: { !$0.attachments.isEmpty }), let attachment = message.attachments.first {
                await open(attachment, of: message)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func reloadQuietly() async {
        if let fresh = try? await model.call({ try await $0.thread(threadId) }) {
            messages = fresh.messages.sorted { ($0.sentDate ?? .distantPast) < ($1.sentDate ?? .distantPast) }
        }
    }

    private func open(_ attachment: AttachmentMeta, of message: Message, for action: AttachmentAction = .preview) async {
        opening = attachment.id
        defer { opening = nil }
        do {
            let url = try await model.openAttachment(attachment, of: message)
            error = nil
            switch action {
            case .preview: preview = url
            case .share: sharing = SharedFile(url: url)
            case .save: saving = url
            }
        } catch {
            self.error = "\(attachment.filename): \(error.localizedDescription)"
        }
    }

    private func cleanUpSaving() {
        if let saving { AttachmentFiles.remove(saving) }
        saving = nil
    }
}

enum AttachmentAction { case preview, share, save }

struct SharedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

struct MessageCard: View {
    var message: Message
    var bodyState: BodyState?
    var text: String?
    var parts: [MessagePart]?
    var linksOpenDirectly: Bool
    var expanded: Bool
    var opening: String?
    var onToggle: () -> Void
    var onUnlock: () -> Void
    var onAttachment: (AttachmentMeta, AttachmentAction) -> Void

    @State private var pendingLink: GuardedLink?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onToggle) { header }
                .buttonStyle(.plain)
                .accessibilityHint(expanded ? "" : "Shows the full message")
            if expanded {
                recipients
                bodyView
                if !message.attachments.isEmpty { attachments }
            } else if let snippet = message.snippet {
                Text(snippet).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.primary.opacity(0.06)))
        .environment(\.openURL, OpenURLAction { url in
            if let guarded = GuardedLink(marker: url) {
                pendingLink = guarded
                return .handled
            }
            if let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" {
                UIApplication.shared.open(url)
                return .handled
            }
            return .systemAction
        })
        .confirmationDialog(
            pendingLink?.domain ?? "Open link?",
            isPresented: Binding(get: { pendingLink != nil }, set: { if !$0 { pendingLink = nil } }),
            titleVisibility: .visible,
            presenting: pendingLink
        ) { link in
            Button("Open in Safari") { UIApplication.shared.open(link.url) }
            Button("Cancel", role: .cancel) {}
        } message: { link in
            Text("\(link.url.absoluteString)\n\nThis sender isn't on your trusted list, or its sender checks didn't pass. Nothing is loaded until you open it.")
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            Avatar(address: message.from)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(message.from.display).font(.body.weight(.semibold)).lineLimit(1)
                    if message.origin == "sent" { Chip(text: "You", tint: Theme.accent) }
                    Spacer()
                    Text(message.sentDate?.mailListStamp ?? "").font(.caption).foregroundStyle(.secondary)
                }
                Text(message.from.email).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var recipients: some View {
        let to = message.to.map(\.display).joined(separator: ", ")
        let cc = (message.cc ?? []).map(\.display).joined(separator: ", ")
        VStack(alignment: .leading, spacing: 4) {
            if !to.isEmpty { Text("To: \(to)").font(.caption).foregroundStyle(.secondary) }
            if !cc.isEmpty { Text("Cc: \(cc)").font(.caption).foregroundStyle(.secondary) }
            FlowLayout {
                if let verdicts = message.verdicts { authChip(verdicts) }
                if message.pgpEncrypted == true { Chip(text: "OpenPGP", systemImage: "lock.fill", tint: .green) }
                if message.locked { Chip(text: "Sealed to your key", systemImage: "lock.shield", tint: Theme.accent) }
                ForEach(message.labels.filter { $0 != Message.starLabel }, id: \.self) { label in
                    Chip(text: label, systemImage: "tag", tint: .secondary)
                }
            }
        }
    }

    private func authChip(_ verdicts: Verdicts) -> some View {
        let pass = verdicts.dmarc?.lowercased() == "pass"
        let failed = [verdicts.dmarc, verdicts.spf, verdicts.dkim].contains { $0?.lowercased() == "fail" }
        return Chip(
            text: pass ? "Verified sender" : failed ? "Sender not verified" : "Unverified",
            systemImage: pass ? "checkmark.seal.fill" : "exclamationmark.triangle.fill",
            tint: pass ? .green : failed ? .red : .orange
        )
        .accessibilityLabel("SPF \(verdicts.spf ?? "none"), DKIM \(verdicts.dkim ?? "none"), DMARC \(verdicts.dmarc ?? "none")")
    }

    @ViewBuilder
    private var bodyView: some View {
        switch bodyState {
        case .opened:
            if let parts, !parts.isEmpty {
                Text(messageAttributedString(parts, direct: linksOpenDirectly))
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if let text, !text.isEmpty {
                Text(linkified(text))
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("(no text)").font(.body).foregroundStyle(.secondary)
            }
        case .locked:
            Button(action: onUnlock) {
                Label("Sealed. Load your envelope key to read this message on this iPhone.", systemImage: "key.fill")
                    .font(.subheadline)
            }
        case .failed(let reason):
            Label(reason, systemImage: "exclamationmark.lock").font(.subheadline).foregroundStyle(.red)
        case nil:
            HStack(spacing: 8) {
                ProgressView()
                Text("Decrypting…").font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    private var attachments: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(message.attachments) { attachment in
                let name = attachment.filename.isEmpty ? "attachment" : attachment.filename
                HStack(spacing: 4) {
                    Button { onAttachment(attachment, .preview) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: AttachmentImport.systemImage(forContentType: attachment.contentType))
                                .font(.title3)
                                .frame(width: 30)
                                .foregroundStyle(Theme.accent)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(name).font(.subheadline.weight(.medium)).lineLimit(2).truncationMode(.middle)
                                Text("\(ByteSize.format(attachment.size)) · \(attachment.contentType)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 4)
                            if opening == attachment.id { ProgressView() }
                        }
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(name), \(ByteSize.format(attachment.size))")
                    .accessibilityHint("Decrypts and previews the attachment")
                    Menu {
                        actions(for: attachment)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Actions for \(name)")
                }
                .padding(.leading, 10)
                .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .contextMenu { actions(for: attachment) }
                .disabled(opening != nil)
            }
        }
    }

    @ViewBuilder
    private func actions(for attachment: AttachmentMeta) -> some View {
        Button { onAttachment(attachment, .preview) } label: { Label("Preview", systemImage: "eye") }
        Button { onAttachment(attachment, .share) } label: { Label("Share…", systemImage: "square.and.arrow.up") }
        Button { onAttachment(attachment, .save) } label: { Label("Save to Files", systemImage: "folder") }
    }
}
