import LojoMailCore
import SwiftUI

/// What the paperclip offers. Shared by the toolbar button and the Attachments section so both read the same.
struct AttachMenuItems: View {
    var photos: () -> Void
    var camera: () -> Void
    var files: () -> Void

    var body: some View {
        Button(action: photos) { Label("Photo Library", systemImage: "photo.on.rectangle") }
        if CameraPicker.available {
            Button(action: camera) { Label("Take Photo", systemImage: "camera") }
        }
        Button(action: files) { Label("Choose File", systemImage: "folder") }
    }
}

/// The Attachments section of Compose: what is attached, how much of the message limit it uses, and why it might not send.
struct ComposeAttachmentsSection: View {
    let model: ComposeModel
    var photos: () -> Void
    var camera: () -> Void
    var files: () -> Void

    var body: some View {
        Section {
            if model.attachmentsUnsendable {
                Label {
                    Text("This server can't send attachments from the app yet. Remove them to send, or send this message from Thunderbird.")
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.footnote)
                .foregroundStyle(.orange)
            }
            ForEach(model.serverAttachments) { file in
                AttachmentRow(
                    filename: file.filename, size: file.size, contentType: file.contentType,
                    thumbnail: nil, detail: "On the draft",
                    remove: model.closed ? nil : { Task { await model.detach(file) } }
                )
            }
            ForEach(model.attachments) { file in
                AttachmentRow(
                    filename: file.filename, size: file.size, contentType: file.contentType,
                    thumbnail: model.thumbnails[file.id],
                    detail: model.support == nil ? "Not sendable yet" : "Uploads when you save or send",
                    remove: { model.detach(file) }
                )
            }
            if let notice = model.attachmentNotice {
                Label(notice, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            if model.loadingAttachments > 0 {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(model.loadingAttachments == 1 ? "Adding 1 attachment…" : "Adding \(model.loadingAttachments) attachments…")
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
            if !model.closed {
                Menu {
                    AttachMenuItems(photos: photos, camera: camera, files: files)
                } label: {
                    Label("Add Attachment", systemImage: "paperclip")
                }
            }
            if model.hasAttachments {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: min(model.budgetUsage, 1))
                        .tint(model.overBudget ? .red : model.budgetUsage > 0.85 ? .orange : Theme.accent)
                    Text("\(ByteSize.format(model.attachedBytes)) attached · \(model.overBudget ? "over" : "\(ByteSize.format(model.roomLeft)) left of") the \(ByteSize.format(model.budget.maxMessageBytes)) message limit")
                        .font(.caption)
                        .foregroundStyle(model.overBudget ? .red : .secondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Message size")
                .accessibilityValue(model.overBudget
                    ? "Over the \(ByteSize.format(model.budget.maxMessageBytes)) limit"
                    : "\(ByteSize.format(model.attachedBytes)) attached, \(ByteSize.format(model.roomLeft)) left")
            }
        } header: {
            Text("Attachments")
        } footer: {
            if !model.hasAttachments {
                Text("Up to \(ByteSize.format(model.budget.maxMessageBytes)) per message including encoding, about \(ByteSize.format(model.roomLeft)) of files. Photos are sent as JPEG without location data.")
            }
        }
    }
}

struct AttachmentRow: View {
    let filename: String
    let size: Int
    let contentType: String
    let thumbnail: UIImage?
    let detail: String?
    var remove: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let thumbnail {
                    Image(uiImage: thumbnail).resizable().scaledToFill()
                } else {
                    Image(systemName: AttachmentImport.systemImage(forContentType: contentType))
                        .font(.title3)
                        .foregroundStyle(Theme.accent)
                }
            }
            .frame(width: 40, height: 40)
            .background(Color(.tertiarySystemFill))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(filename).lineLimit(2).truncationMode(.middle)
                Text([ByteSize.format(size), detail].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if let remove {
                Button(action: remove) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Remove \(filename)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(filename), \(ByteSize.format(size))")
    }
}
