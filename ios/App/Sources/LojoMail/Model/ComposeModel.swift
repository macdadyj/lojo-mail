import Foundation
import LojoMailCore
import Observation
import UIKit

enum ComposeRequest: Identifiable, Hashable {
    case new(to: String?)
    case reply(Message, all: Bool)
    case forward(Message)
    case aiReply(Message)
    case draft(DraftView)

    var id: String {
        switch self {
        case .new(let to): "new-\(to ?? "")"
        case .reply(let message, let all): "reply-\(message.id)-\(all)"
        case .forward(let message): "fwd-\(message.id)"
        case .aiReply(let message): "ai-\(message.id)"
        case .draft(let view): "draft-\(view.id)"
        }
    }
}

/// One compose or review screen. Sending is the web app's flow (`packages/web/src/Compose.tsx`): save, mint a one-time
/// approval bound to exactly the reviewed recipients, subject, text and encryption, then send with that token.
@MainActor
@Observable
final class ComposeModel {
    var fields = DraftFields()
    private(set) var saved: DraftFields?
    private(set) var draft: Draft?
    private var threadId: String?
    private var inReplyTo: String?
    var busy = false
    var status: String?
    var error: String?
    var conflict: [String]?
    var conflictArmed = true
    var sentMessageId: String?
    var preparing = false
    /// Picked in Compose and not on the server yet. Memory only.
    private(set) var attachments: [OutgoingAttachment] = []
    private(set) var thumbnails: [UUID: UIImage] = [:]
    var loadingAttachments = 0
    /// Why the last file couldn't be added; shown in the Attachments section, next to the paperclip.
    var attachmentNotice: String?

    private let model: AppModel

    init(model: AppModel, request: ComposeRequest) {
        self.model = model
        switch request {
        case .new(let to):
            fields.to = to ?? ""
        case .reply(let message, let all):
            let me = model.mailbox
            if all {
                let recipients = MailText.replyAll(to: message, me: me)
                fields.to = recipients.to.joined(separator: ", ")
                fields.cc = recipients.cc.joined(separator: ", ")
            } else {
                fields.to = message.origin == "sent" ? message.to.map(\.email).joined(separator: ", ") : message.from.email
            }
            fields.subject = MailText.replySubject(message.subject)
            fields.text = MailText.quoted(model.bodyText(message) ?? "", from: message.from, date: message.sentDate)
            threadId = message.threadId
            inReplyTo = message.rfcMessageId
        case .forward(let message):
            fields.subject = MailText.forwardSubject(message.subject)
            fields.text = MailText.forwarded(model.bodyText(message) ?? "(The original text is sealed; load your envelope key to include it.)", message: message)
            if !message.attachments.isEmpty {
                Task { await self.forwardAttachments(of: message) }
            }
        case .aiReply(let message):
            preparing = true
            Task { await self.askAIForReply(message) }
        case .draft(let view):
            show(view)
        }
    }

    var dirty: Bool {
        !attachments.isEmpty || (saved.map { $0 != fields } ?? !(fields.to.isEmpty && fields.subject.isEmpty && fields.text.isEmpty))
    }
    var closed: Bool { draft.map { !$0.status.editable } ?? false }

    // MARK: Attachments

    var support: DraftAttachmentSupport? { model.draftAttachmentSupport }
    var budget: AttachmentBudget { AttachmentBudget(support) }
    var serverAttachments: [DraftAttachment] { draft?.attachments ?? [] }
    var hasAttachments: Bool { !attachments.isEmpty || !serverAttachments.isEmpty }
    private var attachmentSizes: [Int] { serverAttachments.map(\.size) + attachments.map(\.size) }
    private var textBytes: Int { fields.text.utf8.count }
    var attachedBytes: Int { attachmentSizes.reduce(0, +) }
    var budgetUsage: Double { budget.usage(textBytes: textBytes, attachmentSizes: attachmentSizes) }
    var overBudget: Bool { hasAttachments && !budget.fits(textBytes: textBytes, attachmentSizes: attachmentSizes) }
    var roomLeft: Int { budget.remainingRawBytes(textBytes: textBytes, attachmentSizes: attachmentSizes) }

    /// Adds a file if it fits; otherwise says why. Photos may already have been shrunk by the caller.
    @discardableResult
    func attach(_ file: OutgoingAttachment) -> Bool {
        guard !closed else { return false }
        if attachments.contains(where: { $0.sha256 == file.sha256 }) || serverAttachments.contains(where: { $0.sha256 == file.sha256 }) {
            attachmentNotice = "\(file.filename) is already attached."
            return false
        }
        guard attachmentSizes.count < budget.maxFiles else {
            attachmentNotice = "One message can carry up to \(budget.maxFiles) attachments."
            return false
        }
        guard budget.fits(textBytes: textBytes, attachmentSizes: attachmentSizes + [file.size]) else {
            let left = roomLeft
            attachmentNotice = "\(file.filename) is \(ByteSize.format(file.size)). " + (left > 0
                ? "Only \(ByteSize.format(left)) more fits in one message (\(ByteSize.format(budget.maxMessageBytes)) including encoding)."
                : "The message is at its \(ByteSize.format(budget.maxMessageBytes)) limit.") + " Share a link for larger files."
            return false
        }
        attachmentNotice = nil
        attachments.append(file)
        if file.contentType.hasPrefix("image/"), let image = UIImage(data: file.data) {
            thumbnails[file.id] = image.preparingThumbnail(of: CGSize(width: 96, height: 96))
        }
        return true
    }

    func detach(_ file: OutgoingAttachment) {
        attachmentNotice = nil
        attachments.removeAll { $0.id == file.id }
        thumbnails[file.id] = nil
    }

    /// Removes a file that is already on the draft (`POST /v1/drafts/:id/attachments/:attId/remove`).
    func detach(_ file: DraftAttachment) async {
        guard let id = draft?.id else { return }
        busy = true
        defer { busy = false }
        do {
            show(try await model.call { try await $0.removeDraftAttachment(id, attachmentId: file.id) })
            attachmentNotice = nil
        } catch {
            attachmentNotice = "Couldn't remove \(file.filename): \(error.localizedDescription)"
        }
    }

    private func forwardAttachments(of message: Message) async {
        loadingAttachments += message.attachments.count
        var skipped: [String] = []
        for meta in message.attachments {
            defer { loadingAttachments -= 1 }
            guard let data = try? await model.attachmentData(meta, of: message) else {
                skipped.append(meta.filename)
                continue
            }
            if !attach(OutgoingAttachment(filename: meta.filename, contentType: meta.contentType, data: data)) {
                skipped.append(meta.filename)
            }
        }
        if !skipped.isEmpty {
            attachmentNotice = "Not forwarded: \(skipped.joined(separator: ", ")). It couldn't be opened or doesn't fit in \(ByteSize.format(budget.maxMessageBytes))."
        }
    }

    /// Uploads files picked here to the saved draft, one request each, in order, then shows the server's list.
    /// A file that fails stays here (with the ones after it) so Jon can remove it or retry.
    private func uploadAttachments(to id: String) async throws {
        while let file = attachments.first {
            let view: DraftView
            do {
                view = try await model.call { try await $0.addDraftAttachment(id, file) }
            } catch let failure as APIError where failure == .unauthorized || failure.isOffline {
                throw failure
            } catch {
                attachmentNotice = "\(file.filename) wasn't attached: \(error.localizedDescription)"
                throw error
            }
            attachments.removeFirst()
            thumbnails[file.id] = nil
            show(view)
        }
    }

    /// Re-reads `/v1/settings` so the file limits are the server's current ones, never a stale answer.
    func refreshCapabilities() async {
        await model.refreshSettings()
    }

    /// Recipients outside the test address while test mode is on.
    var blockedByTestMode: [String] {
        guard model.sendTestMode else { return [] }
        return fields.allRecipients.filter { $0.lowercased() != AppModel.testAddress }
    }

    private func show(_ view: DraftView) {
        var view = view
        // `/submit` and `/discard` answer without the body text; the editor still holds it.
        if view.text == nil { view.text = fields.text }
        let next = DraftFields(view)
        draft = view.draft
        fields = next
        saved = next
        model.upsertDraft(view)
    }

    private func askAIForReply(_ message: Message) async {
        defer { preparing = false }
        do {
            let sourceText = message.locked ? model.bodyText(message) : nil
            let view = try await model.call { try await $0.draftReply(messageId: message.id, sourceText: sourceText) }
            show(view)
            status = "SI wrote this draft. Nothing is sent until you approve it."
        } catch {
            self.error = error.localizedDescription
            fields.to = message.from.email
            fields.subject = MailText.replySubject(message.subject)
            threadId = message.threadId
            inReplyTo = message.rfcMessageId
        }
    }

    /// Saves the text, then uploads any new attachments to the draft.
    @discardableResult
    func save() async throws -> String {
        guard !fields.toList.isEmpty else { throw APIError.invalid("Add at least one recipient.") }
        if !attachments.isEmpty {
            await model.refreshSettings()
            guard support != nil else {
                throw APIError.invalid("The mail server at \(model.apiBase.host() ?? "this address") doesn't accept attachments on drafts (its /v1/settings has no draftAttachments). Check the server URL in Settings.")
            }
        }
        guard !overBudget else { throw APIError.invalid("The attachments don't fit in one message (\(ByteSize.format(budget.maxMessageBytes))). Remove one.") }
        let id: String
        if let draft, let saved, saved == fields {
            id = draft.id
        } else {
            let fields = fields
            let view: DraftView
            if let existing = draft?.id {
                view = try await model.call { try await $0.updateDraft(existing, fields) }
            } else {
                let threadId = threadId
                let inReplyTo = inReplyTo
                view = try await model.call { try await $0.createDraft(fields, threadId: threadId, inReplyTo: inReplyTo) }
            }
            show(view)
            id = view.draft.id
        }
        try await uploadAttachments(to: id)
        return id
    }

    private func run(_ action: () async throws -> Void) async {
        busy = true
        error = nil
        status = nil
        defer { busy = false }
        do {
            try await action()
        } catch let failure as ConflictFailure {
            conflict = failure.changed
        } catch {
            self.error = error.localizedDescription
        }
    }

    func saveDraft() async {
        await run {
            try await save()
            status = "Saved as a draft. Nothing is sent until you approve it."
        }
    }

    func saveToApprovalQueue() async {
        await run {
            let id = try await save()
            let view = try await model.call { try await $0.submitForApproval(id) }
            show(view)
            status = "In the approval queue (Review tab)."
        }
    }

    func rewrite(_ instruction: String) async {
        await run {
            let id = try await save()
            let view = try await model.call { try await $0.rewrite(id, instruction: instruction) }
            show(view)
            status = "Rewritten by SI. Still a draft."
        }
    }

    func discard() async -> Bool {
        guard let id = draft?.id else { return true }
        var ok = false
        await run {
            show(try await model.call { try await $0.discard(id) })
            ok = true
        }
        return ok
    }

    private struct ConflictFailure: Error { var changed: [String] }

    /// The human approval. Refuses in test mode for anyone but the test address, and if the draft changed underneath.
    func approveAndSend() async {
        guard blockedByTestMode.isEmpty else {
            error = "Test mode is on: only \(AppModel.testAddress) can receive mail from this app. Turn it off in Settings."
            return
        }
        guard conflictArmed else { return }
        await run {
            var shown = fields
            shown.attachments = DraftFields.reviewedAttachments(onDraft: serverAttachments, pending: attachments)
            let reviewed = shown
            let id = try await save()
            let token: String
            do {
                token = try await model.call { try await $0.mintApproval(id, reviewed: reviewed) }
            } catch APIError.conflict {
                let current = try await model.call { try await $0.draft(id) }
                show(current)
                conflictArmed = false
                Task {
                    try? await Task.sleep(for: .seconds(3))
                    self.conflictArmed = true
                }
                throw ConflictFailure(changed: reviewed.changed(comparedTo: DraftFields(current)))
            }
            conflict = nil
            let receipt = try await model.call { try await $0.approveAndSendReceipt(id, approvalToken: token) }
            sentMessageId = receipt.messageId
            if let view = try? await model.call({ try await $0.draft(id) }) { show(view) }
            status = receipt.summary
            await model.refresh(.sent)
        }
    }
}
