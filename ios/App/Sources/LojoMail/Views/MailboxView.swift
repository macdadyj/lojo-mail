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

    private var state: FolderState { model.state(folder) }

    private var visible: [Conversation] {
        let conversations = state.conversations
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty, results == nil else { return conversations }
        return conversations.filter { conversation in
            conversation.messages.contains { message in
                message.subject.lowercased().contains(q) || message.from.email.lowercased().contains(q)
                    || (message.from.name ?? "").lowercased().contains(q) || (message.snippet ?? "").lowercased().contains(q)
            }
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            list
                .navigationTitle(folder.title)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { folderMenu }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { compose = .new(to: nil) } label: { Image(systemName: "square.and.pencil") }
                            .accessibilityLabel("New message")
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
            if model.keyMismatch {
                Button { showKeySetup = true } label: {
                    Banner(text: "The key on this iPhone doesn't match this mailbox, so mail won't open. Tap to replace it.", systemImage: "exclamationmark.lock.fill", tint: .red)
                }
                .buttonStyle(.plain)
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
                    NavigationLink(value: ThreadRoute(threadId: conversation.id, folder: folder)) {
                        ConversationRow(conversation: conversation, me: model.mailbox)
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) { leadingActions(conversation) }
                    .swipeActions(edge: .trailing, allowsFullSwipe: folder != .trash) { trailingActions(conversation) }
                    .contextMenu { contextActions(conversation) }
                }
            }
        }
        .listStyle(.plain)
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
                    folder = item
                } label: {
                    let unread = model.state(item).unreadCount
                    Label(unread > 0 && item != .trash ? "\(item.title) (\(unread))" : item.title, systemImage: item.systemImage)
                }
            }
        } label: {
            Label("Folders", systemImage: "sidebar.left")
        }
        .accessibilityLabel("Folders")
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
        } else {
            Button(role: .destructive) {
                Task { await model.trash(conversation.messages, from: folder) }
            } label: {
                Label("Trash", systemImage: "trash")
            }
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
        case .drafts: "Drafts live in the Review tab, with the approval queue."
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

    var body: some View {
        let latest = conversation.latest
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(conversation.unread ? Theme.unread : .clear)
                .frame(width: 9, height: 9)
                .padding(.top, 6)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(conversation.participants(me: me))
                        .font(.body.weight(conversation.unread ? .bold : .regular))
                        .lineLimit(1)
                    if conversation.count > 1 {
                        Text("\(conversation.count)").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 6)
                    if conversation.starred {
                        Image(systemName: "star.fill").font(.caption).foregroundStyle(Theme.star).accessibilityLabel("Starred")
                    }
                    if conversation.hasAttachments {
                        Image(systemName: "paperclip").font(.caption).foregroundStyle(.secondary).accessibilityLabel("Has attachments")
                    }
                    Text(conversation.date?.mailListStamp ?? "").font(.caption).foregroundStyle(.secondary)
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
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the conversation")
    }

    @ViewBuilder
    private var chips: some View {
        let latest = conversation.latest
        let priority = latest.ai?.priority
        if conversation.phishy || priority == "now" || showFolder || latest.bulk == true || latest.pgpEncrypted == true {
            HStack(spacing: 5) {
                if conversation.phishy { Chip(text: "Possible phishing", systemImage: "exclamationmark.shield.fill", tint: .red) }
                if priority == "now" { Chip(text: "Now", systemImage: "bolt.fill", tint: .orange) }
                if latest.pgpEncrypted == true { Chip(text: "OpenPGP", systemImage: "lock.fill", tint: .green) }
                if latest.bulk == true { Chip(text: "Bulk", tint: .secondary) }
                if showFolder, let folder = latest.folderValue { Chip(text: folder.title, systemImage: folder.systemImage, tint: Theme.accent) }
            }
            .padding(.top, 2)
        }
    }
}
