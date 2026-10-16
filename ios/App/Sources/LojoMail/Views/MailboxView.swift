import LojoMailCore
import SwiftUI

struct ThreadRoute: Hashable {
    var threadId: String
    var folder: Folder
}

struct MailboxView: View {
    @Environment(AppModel.self) private var model
    @State private var folder: Folder = .inbox
    @State private var path = NavigationPath()
    @State private var query = ""
    @State private var results: [Message]?
    @State private var searching = false
    @State private var searchError: String?
    @State private var compose: ComposeRequest?
    @State private var showKeySetup = false
    @State private var appliedLaunch = false
    @State private var selecting = false
    @State private var selectedThreads: Set<String> = []
    @State private var siFilter: SiFilterRequest?
    @State private var messageFilter: SiMessageFilterRequest?
    @State private var labelFilter: String?
    @Environment(\.openReview) private var openReview

    private var state: FolderState { model.state(folder) }

    private var visible: [Conversation] {
        let conversations = state.conversations
        let labeled = labelFilter.map { label in
            conversations.filter { $0.messages.contains { $0.labels.contains(label) } }
        } ?? conversations
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty, results == nil else { return labeled }
        return labeled.filter { conversation in
            conversation.messages.contains { message in
                message.subject.lowercased().contains(q) || message.from.email.lowercased().contains(q)
                    || (message.from.name ?? "").lowercased().contains(q) || (message.snippet ?? "").lowercased().contains(q)
            }
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            list
                .navigationTitle(labelFilter.map(SiLabels.title) ?? folder.title)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { folderMenu }
                    ToolbarItem(placement: .topBarTrailing) { moreMenu }
                    ToolbarItem(placement: .topBarTrailing) { filterButton }
                    ToolbarItem(placement: .primaryAction) {
                        Button { compose = .new(to: nil) } label: { Image(systemName: "square.and.pencil") }
                            .accessibilityLabel("New message")
                            .accessibilityIdentifier("mail.compose")
                    }
                }
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search all mail")
                .onSubmit(of: .search) { Task { await runSearch() } }
                .onChange(of: query) { _, value in if value.isEmpty { results = nil; searchError = nil } }
                .navigationDestination(for: ThreadRoute.self) { route in
                    ThreadView(threadId: route.threadId, folder: route.folder)
                }
                .refreshable { await model.refresh(folder) }
                .task(id: folder) {
                    if model.state(folder).updatedAt == nil || model.state(folder).fromCache { await model.refresh(folder) }
                }
        }
        .sheet(item: $compose) { request in
            NavigationStack { ComposeView(request: request, presentedAsSheet: true) }
        }
        .sheet(item: $siFilter) { request in
            NavigationStack { SiFilterView(request: request) }
        }
        .sheet(item: $messageFilter) { request in
            NavigationStack { SiMessageFilterView(request: request, existingLabels: model.mailLabels) }
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showKeySetup) { KeySetupView() }
        .onChange(of: model.openThreadRequest) { _, id in
            guard let id else { return }
            model.openThreadRequest = nil
            path.append(ThreadRoute(threadId: id, folder: .inbox))
        }
        .task { await applyLaunch() }
    }

    @ViewBuilder
    private var list: some View {
        List {
            if !model.online {
                Banner(text: offlineText, systemImage: "wifi.slash", tint: .orange)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
            if model.sendTestMode {
                Button { model.sendTestMode = false } label: {
                    Banner(text: "Test mode is on. Sending only goes to \(AppModel.testAddress). Tap to turn it off.", systemImage: "testtube.2", tint: .orange)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("testmode.off")
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
            if model.keyMismatch {
                Button { showKeySetup = true } label: {
                    Banner(text: "The key on this iPhone doesn't match this mailbox, so mail won't open. Tap to replace it.", systemImage: "exclamationmark.lock.fill", tint: .red)
                }
                .buttonStyle(.plain)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            } else if model.key == nil && model.keyReadUnavailable {
                Button { model.restoreAfterForeground() } label: {
                    Banner(text: "Your envelope key is still in the Keychain. Unlock this iPhone and tap to try again.", systemImage: "lock.fill", tint: .orange)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("unlock.retry-keychain")
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            } else if model.key == nil {
                Button { showKeySetup = true } label: {
                    Banner(text: "Bodies are sealed. Tap to load your envelope key.", systemImage: "key.fill", tint: Theme.accent)
                }
                .buttonStyle(.plain)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
            if folder == .inbox, model.reviewCount > 0, results == nil {
                Button {
                    openReview()
                } label: {
                    Banner(
                        text: AppChrome.reviewBanner(waiting: model.reviewCount),
                        systemImage: "tray.full",
                        tint: Theme.accent
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("mail.approval-queue.banner")
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 2, trailing: 16))
            }
            if folder == .trash, !visible.isEmpty {
                Text("Mail in Trash is kept \(model.rules?.rules.trashRetentionDays ?? 30) days, then purged. Swipe to restore.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .listRowSeparator(.hidden)
            }
            if let results {
                searchResults(results)
            } else {
                ForEach(visible) { conversation in
                    HStack(spacing: 8) {
                        if selecting {
                            Button {
                                if selectedThreads.contains(conversation.id) { selectedThreads.remove(conversation.id) } else { selectedThreads.insert(conversation.id) }
                            } label: {
                                Image(systemName: selectedThreads.contains(conversation.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(Theme.accent)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(selectedThreads.contains(conversation.id) ? "Deselect" : "Select")
                        }
                        NavigationLink(value: ThreadRoute(threadId: conversation.id, folder: folder)) {
                            ConversationRow(conversation: conversation, me: model.mailbox)
                        }
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) { leadingActions(conversation) }
                    .swipeActions(edge: .trailing, allowsFullSwipe: folder != .trash) { trailingActions(conversation) }
                    .contextMenu { contextActions(conversation) }
                }
            }
        }
        .listStyle(.plain)
        .listRowSpacing(2)
        .overlay { overlay }
    }

    @ViewBuilder
    private var overlay: some View {
        if results == nil {
            if state.messages.isEmpty {
                if state.loading {
                    ProgressView("Loading \(folder.title)…")
                } else if let error = state.error {
                    StateView(title: model.online ? "Couldn't load \(folder.title)" : "You're offline", systemImage: model.online ? "exclamationmark.icloud" : "wifi.slash", message: error, actionTitle: "Try again") {
                        Task { await model.refresh(folder) }
                    }
                } else if state.updatedAt != nil {
                    StateView(title: emptyTitle, systemImage: folder.systemImage, message: emptyMessage)
                }
            } else if visible.isEmpty && !query.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        } else if searching {
            ProgressView("Searching…")
        }
    }

    @ViewBuilder
    private func searchResults(_ messages: [Message]) -> some View {
        Section {
            if let searchError {
                Text(searchError).foregroundStyle(.red).font(.footnote)
            }
            if messages.isEmpty && !searching {
                ContentUnavailableView.search(text: query)
            }
            ForEach(Conversation.group(messages)) { conversation in
                NavigationLink(value: ThreadRoute(threadId: conversation.id, folder: conversation.latest.folderValue ?? .inbox)) {
                    ConversationRow(conversation: conversation, me: model.mailbox, showFolder: true)
                }
            }
        } header: {
            Text("\(messages.count) result\(messages.count == 1 ? "" : "s") in all folders · subject, sender and snippet")
                .font(.caption)
                .textCase(nil)
        }
    }

    private var folderMenu: some View {
        Menu {
            ForEach(Folder.allCases) { item in
                Button {
                    results = nil
                    labelFilter = nil
                    folder = item
                } label: {
                    let unread = model.state(item).unreadCount
                    Label(unread > 0 && item != .trash ? "\(item.title) (\(unread))" : item.title, systemImage: item.systemImage)
                }
            }
            if !model.mailLabels.isEmpty {
                Divider()
                ForEach(model.mailLabels, id: \.self) { label in
                    Button {
                        results = nil
                        labelFilter = label
                    } label: {
                        Label(SiLabels.title(label), systemImage: labelFilter == label ? "folder.fill" : "folder")
                    }
                }
            }
        } label: {
            Label("Folders", systemImage: "tray.2")
        }
        .accessibilityLabel("Folders")
        .accessibilityIdentifier("mail.folders")
    }

    private var filterButton: some View {
        Button {
            openFilter(selectedOnly: selecting && !selectedThreads.isEmpty)
        } label: {
            Image(systemName: SiEntry.icon)
        }
        .accessibilityLabel(SiEntry.filterTitle)
        .accessibilityIdentifier("si.filter")
    }

    private var moreMenu: some View {
        Menu {
            Button(selecting ? "Done selecting" : "Select messages", systemImage: selecting ? "checkmark.circle.fill" : "checklist") {
                selecting.toggle()
                if !selecting { selectedThreads = [] }
            }
            Button(AppChrome.reviewMenuLabel(waiting: model.reviewCount), systemImage: "tray.full") {
                openReview()
            }
            .accessibilityIdentifier("mail.approval-queue")
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("More")
        .accessibilityIdentifier("mail.more")
    }

    private func openMessageFilter(_ conversation: Conversation) {
        let messages = conversation.messages
        guard let target = messages.last(where: { $0.origin != "sent" }) ?? messages.last else { return }
        let email = target.from.email
        messageFilter = SiMessageFilterRequest(
            messageIds: messages.map(\.id),
            from: email,
            domain: email.split(separator: "@").last.map(String.init) ?? "",
            subject: target.subject,
            texts: model.siTexts(for: messages)
        )
    }

    private func openFilter(selectedOnly: Bool) {
        let conversations = selectedOnly ? visible.filter { selectedThreads.contains($0.id) } : visible
        let messages = conversations.flatMap(\.messages)
        let ids = messages.map(\.id)
        if ids.isEmpty && !selectedOnly {
            siFilter = SiFilterRequest(messageIds: [], folder: folder.rawValue, texts: [:])
        } else {
            siFilter = SiFilterRequest(messageIds: ids, folder: nil, texts: model.siTexts(for: messages))
        }
    }

    @ViewBuilder
    private func leadingActions(_ conversation: Conversation) -> some View {
        Button {
            Task { await model.setUnread(conversation.messages, !conversation.unread) }
        } label: {
            Label(conversation.unread ? "Read" : "Unread", systemImage: conversation.unread ? "envelope.open" : "envelope.badge")
        }
        .tint(Theme.unread)
        Button {
            Task { await model.setStar(conversation.messages, !conversation.starred) }
        } label: {
            Label(conversation.starred ? "Unstar" : "Star", systemImage: conversation.starred ? "star.slash" : "star")
        }
        .tint(Theme.star)
    }

    @ViewBuilder
    private func trailingActions(_ conversation: Conversation) -> some View {
        if folder == .trash {
            Button {
                Task { await model.restore(conversation.messages) }
            } label: {
                Label("Restore", systemImage: "arrow.uturn.backward")
            }
            .tint(.green)
            Button {
                openMessageFilter(conversation)
            } label: {
                Label(SiEntry.filterTitle, systemImage: SiEntry.icon)
            }
            .tint(Theme.si)
            .accessibilityIdentifier("si.filter.swipe")
        } else {
            Button(role: .destructive) {
                Task { await model.trash(conversation.messages, from: folder) }
            } label: {
                Label("Trash", systemImage: "trash")
            }
            Button {
                openMessageFilter(conversation)
            } label: {
                Label(SiEntry.filterTitle, systemImage: SiEntry.icon)
            }
            .tint(Theme.si)
            .accessibilityIdentifier("si.filter.swipe")
            if folder != .archive {
                Button {
                    Task { await model.archive(conversation.messages, from: folder) }
                } label: {
                    Label("Archive", systemImage: "archivebox")
                }
                .tint(.indigo)
            }
        }
    }

    @ViewBuilder
    private func contextActions(_ conversation: Conversation) -> some View {
        leadingActions(conversation)
        Button {
            openMessageFilter(conversation)
        } label: {
            Label(SiEntry.filterTitle, systemImage: SiEntry.icon)
        }
        Menu("Move to") {
            ForEach(Folder.moveTargets.filter { $0 != folder }) { target in
                Button {
                    Task { await model.move(conversation.messages, from: folder, to: target) }
                } label: {
                    Label(target.title, systemImage: target.systemImage)
                }
            }
        }
        trailingActions(conversation)
    }

    private var offlineText: String {
        if let updated = state.updatedAt { return "Offline · showing mail from \(updated.formatted(date: .omitted, time: .shortened))" }
        return "Offline"
    }

    private var emptyTitle: String {
        switch folder {
        case .inbox: "Inbox zero"
        case .trash: "Trash is empty"
        case .spam: "No junk"
        default: "Nothing in \(folder.title)"
        }
    }

    private var emptyMessage: String? {
        switch folder {
        case .inbox: "New mail to \(model.mailbox) shows up here."
        case .drafts: "Drafts live in the Approval queue (Mail menu or Settings)."
        case .trash: "Deleted mail stays here for \(model.rules?.rules.trashRetentionDays ?? 30) days and can be restored."
        default: nil
        }
    }

    private func runSearch() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        searching = true
        searchError = nil
        results = []
        defer { searching = false }
        do {
            results = try await model.search(q)
        } catch {
            searchError = error.localizedDescription
        }
    }

    private func applyLaunch() async {
        guard !appliedLaunch else { return }
        appliedLaunch = true
        let launch = model.launch
        if let target = launch.folder { folder = target }
        switch launch.screen {
        case .thread, .attachment:
            if model.state(folder).messages.isEmpty { await model.refresh(folder) }
            let id = launch.thread ?? model.state(folder).conversations.first(where: { $0.hasAttachments })?.id ?? model.state(folder).conversations.first?.id
            if let id { path.append(ThreadRoute(threadId: id, folder: folder)) }
        case .compose, .sendconfirm:
            compose = .new(to: launch.composeTo)
        case .search:
            if let q = launch.search {
                query = q
                await runSearch()
            }
        default:
            break
        }
    }
}

struct ConversationRow: View {
    var conversation: Conversation
    var me: String
    var showFolder = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let latest = conversation.latest
        HStack(alignment: .top, spacing: 12) {
            ZStack(alignment: .topLeading) {
                Avatar(address: conversation.latest.origin == "sent" ? (conversation.latest.to.first ?? conversation.latest.from) : conversation.latest.from)
                Circle()
                    .fill(conversation.unread ? Theme.unread : .clear)
                    .frame(width: 10, height: 10)
                    .offset(x: -2, y: -1)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                if typeSize.isAccessibilitySize {
                    sender.lineLimit(2)
                    HStack(spacing: 6) { markers; stamp }
                } else {
                    HStack(alignment: .firstTextBaseline) {
                        sender.lineLimit(1)
                        Spacer(minLength: 6)
                        markers
                        stamp
                    }
                }
                Text(conversation.subject)
                    .font(.subheadline.weight(conversation.unread ? .semibold : .regular))
                    .lineLimit(1)
                if let snippet = latest.snippet, !snippet.isEmpty {
                    Text(snippet).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                chips
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the conversation")
        .accessibilityIdentifier("mail.row.\(conversation.id)")
    }

    private var sender: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(conversation.participants(me: me))
                .font(.body.weight(conversation.unread ? .semibold : .regular))
            if conversation.count > 1 {
                Text("\(conversation.count)").font(.caption).foregroundStyle(.secondary).accessibilityLabel("\(conversation.count) messages")
            }
        }
    }

    @ViewBuilder
    private var markers: some View {
        if conversation.starred {
            Image(systemName: "star.fill").font(.caption).foregroundStyle(Theme.star).accessibilityLabel("Starred")
        }
        if conversation.hasAttachments {
            Image(systemName: "paperclip").font(.caption).foregroundStyle(.secondary).accessibilityLabel("Has attachments")
        }
    }

    private var stamp: some View {
        Text(conversation.date?.mailListStamp ?? "").font(.caption).foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var chips: some View {
        let latest = conversation.latest
        let priority = latest.ai?.priority
        if conversation.phishy || priority == "now" || showFolder || latest.bulk == true || latest.pgpEncrypted == true {
            FlowLayout {
                if conversation.phishy { Chip(text: "Possible phishing", systemImage: "exclamationmark.shield.fill", tint: .red) }
                if priority == "now" { Chip(text: "Now", systemImage: "bolt.fill", tint: .orange) }
                if latest.pgpEncrypted == true { Chip(text: "OpenPGP", systemImage: "lock.fill", tint: .green) }
                if latest.bulk == true { Chip(text: "Bulk", systemImage: "megaphone", tint: .secondary) }
                if showFolder, let folder = latest.folderValue { Chip(text: folder.title, systemImage: folder.systemImage, tint: Theme.accent) }
            }
            .padding(.top, 2)
        }
    }
}
