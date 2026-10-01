import Foundation
import XCTest
@testable import LojoMailCore

/// The app's mail actions against the deployed API, through the same `APIClient` the app uses. Opt-in twice over:
/// `LOJO_LIVE_WRITE=1` on top of the live session (`scripts/test-core.sh --live-write`). It only touches mail from or to
/// `lojo-test@cyberphysical.us`, sends only to that address (three messages: one text-only, two with files), and puts
/// every flag, folder and switch back the way it found it.
final class LiveWriteTests: XCTestCase {
    static let testAddress = "lojo-test@cyberphysical.us"

    private func live() throws -> APIClient {
        let env = ProcessInfo.processInfo.environment
        guard env["LOJO_LIVE_WRITE"] == "1", let sessionFile = env["LOJO_LIVE_SESSION_FILE"] else {
            throw XCTSkip("live write test not requested")
        }
        let token = try String(contentsOfFile: sessionFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let base = env["LOJO_LIVE_API"].flatMap(URL.init(string:)) ?? APIClient.defaultBaseURL
        return APIClient(baseURL: base, token: token)
    }

    private func find(_ api: APIClient, _ id: String) async throws -> Message {
        try await api.message(id)
    }

    func testMessageActionsRoundTrip() async throws {
        let api = try live()
        let inbox = try await api.folder(.inbox, limit: 100)
        let target = try XCTUnwrap(inbox.first { $0.from.email.lowercased() == Self.testAddress }, "no mail from \(Self.testAddress) in Inbox")
        let original = target

        try await api.setUnread(target.id, !original.unread)
        let flippedUnread = try await find(api, target.id).unread
        XCTAssertEqual(flippedUnread, !original.unread)
        try await api.setUnread(target.id, original.unread)
        let resetUnreadAgain = try await find(api, target.id).unread
        XCTAssertEqual(resetUnreadAgain, original.unread)

        let starred = original.labels.contains(Message.starLabel)
            ? original.labels.filter { $0 != Message.starLabel }
            : original.labels + [Message.starLabel]
        try await api.setLabels(target.id, starred)
        let flippedStar = try await find(api, target.id).starred
        XCTAssertEqual(flippedStar, !original.starred)
        try await api.setLabels(target.id, original.labels)
        let resetStarAgain = try await find(api, target.id).starred
        XCTAssertEqual(resetStarAgain, original.starred)

        try await api.archive(target.id)
        let archived = try await find(api, target.id).folder
        XCTAssertEqual(archived, Folder.archive.rawValue)
        try await api.move(target.id, to: .inbox)
        let moved = try await find(api, target.id).folder
        XCTAssertEqual(moved, Folder.inbox.rawValue)

        try await api.move(target.id, to: .trash)
        let trashed = try await find(api, target.id)
        XCTAssertEqual(trashed.folder, Folder.trash.rawValue)
        XCTAssertEqual(trashed.trashedBy, "human")
        XCTAssertNotNil(trashed.keepUntil)
        let listedInTrash = try await api.folder(.trash).contains { $0.id == target.id }
        XCTAssertTrue(listedInTrash)
        try await api.restore(target.id)
        let restored = try await find(api, target.id)
        XCTAssertEqual(restored.folder, Folder.inbox.rawValue)
        XCTAssertNil(restored.trashedAt)

        let hits = try await api.search(String(original.subject.prefix(20)))
        XCTAssertTrue(hits.contains { $0.id == target.id }, "search for the subject finds the message")
        print("live-write: unread, star, archive, trash/restore and search round-tripped on \(target.id)")
    }

    func testKillSwitchesBlockSendAndRestore() async throws {
        let api = try live()
        let before = try await api.rules().rules
        do {
            try await exerciseSwitches(api, before)
        } catch {
            _ = try? await api.setRuleSwitches(paused: before.paused, killSwitch: before.killSwitch, sendKillSwitch: before.sendKillSwitch ?? false)
            throw error
        }
        let after = try await api.rules().rules
        XCTAssertEqual(after.paused, before.paused)
        XCTAssertEqual(after.killSwitch, before.killSwitch)
        XCTAssertEqual(after.sendKillSwitch ?? false, before.sendKillSwitch ?? false)
        print("live-write: send kill switch refused approve-and-send; paused/killSwitch/sendKillSwitch restored")
    }

    private func exerciseSwitches(_ api: APIClient, _ before: RulesDocument) async throws {
        let draft = try await api.createDraft(
            DraftFields(to: Self.testAddress, subject: "LOJO Mail iOS kill switch check (must not send)", text: "If this arrives the send kill switch failed."),
            threadId: nil, inReplyTo: nil)
        let engaged = try await api.setRuleSwitches(sendKillSwitch: true)
        XCTAssertEqual(engaged.sendKillSwitch, true)
        do {
            let token = try await api.mintApproval(draft.id, reviewed: DraftFields(draft))
            _ = try await api.approveAndSend(draft.id, approvalToken: token)
            XCTFail("approve-and-send went through with the send kill switch on")
        } catch APIError.forbidden(let message) {
            XCTAssertTrue(message.localizedCaseInsensitiveContains("kill switch"), message)
        }
        _ = try? await api.discard(draft.id)

        let released = try await api.setRuleSwitches(sendKillSwitch: before.sendKillSwitch ?? false)
        XCTAssertEqual(released.sendKillSwitch ?? false, before.sendKillSwitch ?? false)
        let toggledKill = try await api.setRuleSwitches(killSwitch: !before.killSwitch).killSwitch
        XCTAssertEqual(toggledKill, !before.killSwitch)
        let resetKillAgain = try await api.setRuleSwitches(killSwitch: before.killSwitch).killSwitch
        XCTAssertEqual(resetKillAgain, before.killSwitch)
        let toggledPaused = try await api.setRuleSwitches(paused: !before.paused).paused
        XCTAssertEqual(toggledPaused, !before.paused)
        let resetPausedAgain = try await api.setRuleSwitches(paused: before.paused).paused
        XCTAssertEqual(resetPausedAgain, before.paused)
    }

    /// The one real send: a draft to lojo-test, through the approval queue, approved with a token bound to the content.
    func testDraftQueueApproveAndSendToTestAddress() async throws {
        let api = try live()
        let stamp = ISO8601DateFormatter().string(from: Date())
        let fields = DraftFields(to: Self.testAddress, subject: "LOJO Mail iOS approve-and-send test \(stamp)", text: "Sent by the LOJO Mail iOS test suite through the approval flow. Safe to trash.")
        XCTAssertEqual(fields.allRecipients, [Self.testAddress])

        let created = try await api.createDraft(fields, threadId: nil, inReplyTo: nil)
        var edited = DraftFields(created)
        edited.text += "\n\nEdited before approval."
        _ = try await api.updateDraft(created.id, edited)
        let queued = try await api.submitForApproval(created.id)
        XCTAssertEqual(queued.draft.status, .pendingApproval)

        do {
            var stale = edited
            stale.subject += " (changed after review)"
            _ = try await api.mintApproval(created.id, reviewed: stale)
            XCTFail("approval minted for content that doesn't match the draft")
        } catch APIError.conflict {}

        XCTAssertNil(queued.text, "submit answers without text; ComposeModel.show keeps the editor's body")
        var reviewed = DraftFields(queued)
        reviewed.text = edited.text
        let token = try await api.mintApproval(created.id, reviewed: reviewed)
        let messageId = try await api.approveAndSend(created.id, approvalToken: token)
        XCTAssertFalse(messageId.isEmpty)
        let status = try await api.draft(created.id).draft.status
        XCTAssertEqual(status, .sent)
        print("live-write: sent one message to \(Self.testAddress) via approve-and-send")
    }

    /// A 1×1 PNG.
    static let pixel = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")!

    /// Files through the app's flow, to lojo-test only: upload in order, remove, the 4 MB and 10-file limits, an
    /// approval bound to each file's SHA-256, then a plain-TLS send (`pgp: off`) whose Sent copy carries both files.
    func testAttachmentsApproveAndSendPlainTLS() async throws {
        let api = try live()
        let settings = try await api.settings()
        let limits = try XCTUnwrap(settings.draftAttachments, "/v1/settings has no draftAttachments")
        XCTAssertEqual(limits.maxMessageBytes, 4_000_000)
        XCTAssertEqual(limits.maxFiles, 10)

        let stamp = ISO8601DateFormatter().string(from: Date())
        let subject = "LOJO Mail iOS attachments test, TLS \(stamp)"
        let note = OutgoingAttachment(filename: "notes.txt", contentType: "text/plain", data: Data("Attached by the LOJO Mail iOS tests \(stamp).\n".utf8))
        let png = OutgoingAttachment(filename: "pixel.png", contentType: "image/png", data: Self.pixel)
        let created = try await api.createDraft(
            DraftFields(to: Self.testAddress, subject: subject, text: "Two files, sent in plain TLS by the LOJO Mail iOS test suite. Safe to trash.", pgp: .off),
            threadId: nil, inReplyTo: nil)
        do {
            try await exerciseAttachments(api, created, note, png)
        } catch {
            _ = try? await api.discard(created.id)
            throw error
        }

        let sent = try await api.folder(.sent, limit: 25).first { $0.subject == subject }
        let copy = try XCTUnwrap(sent, "the Sent copy of \(subject)")
        XCTAssertEqual(copy.attachments.map(\.filename).sorted(), ["notes.txt", "pixel.png"])
        print("live-write: sent \(copy.attachments.count) files in plain TLS to \(Self.testAddress); removed, 413 and 11th-file refusals, and stale approvals checked")
    }

    private func exerciseAttachments(_ api: APIClient, _ created: DraftView, _ note: OutgoingAttachment, _ png: OutgoingAttachment) async throws {
        _ = try await api.addDraftAttachment(created.id, note)
        var view = try await api.addDraftAttachment(created.id, png)
        XCTAssertEqual(view.draft.attachments?.map(\.sha256), [note.sha256, png.sha256], "server keeps upload order and our hashes")
        XCTAssertEqual(view.draft.attachments?.map(\.filename), ["notes.txt", "pixel.png"])
        XCTAssertEqual(view.draft.attachments?.map(\.size), [note.size, png.size])
        XCTAssertNotNil(view.text, "the upload answers with the draft text for a human session")

        let extra = OutgoingAttachment(filename: "extra.bin", contentType: "application/octet-stream", data: Data((0..<64).map { UInt8($0) }))
        view = try await api.addDraftAttachment(created.id, extra)
        let extraId = try XCTUnwrap(view.draft.attachments?.last?.id)
        view = try await api.removeDraftAttachment(created.id, attachmentId: extraId)
        XCTAssertEqual(view.draft.attachments?.map(\.sha256), [note.sha256, png.sha256], "remove takes out only that file")

        do {
            _ = try await api.addDraftAttachment(created.id, OutgoingAttachment(filename: "big.bin", contentType: "application/octet-stream", data: Data(count: 2_990_000)))
            XCTFail("a file that takes the message over 4 MB was accepted")
        } catch let error as APIError {
            guard case .tooLarge = error else { throw error }
            XCTAssertFalse(AttachmentBudget().fits(textBytes: 80, attachmentSizes: [note.size, png.size, 2_990_000]), "the app refuses it before uploading too")
        }

        var fillers: [String] = []
        for index in 0..<8 {
            let filler = OutgoingAttachment(filename: "filler-\(index).txt", contentType: "text/plain", data: Data("filler \(index)".utf8))
            let added = try await api.addDraftAttachment(created.id, filler)
            fillers.append(try XCTUnwrap(added.draft.attachments?.last?.id))
        }
        do {
            _ = try await api.addDraftAttachment(created.id, OutgoingAttachment(filename: "eleventh.txt", contentType: "text/plain", data: Data("11".utf8)))
            XCTFail("an eleventh file was accepted")
        } catch APIError.invalid(let message) {
            XCTAssertTrue(message.contains("10"), message)
        }
        for id in fillers { view = try await api.removeDraftAttachment(created.id, attachmentId: id) }
        XCTAssertEqual(view.draft.attachments?.count, 2)

        let reviewed = DraftFields(view)
        XCTAssertEqual(reviewed.attachments, DraftFields.reviewedAttachments(onDraft: [], pending: [note, png]))
        for wrong in [[], [png.sha256, note.sha256], [note.sha256]] {
            var stale = reviewed
            stale.attachments = wrong
            do {
                _ = try await api.mintApproval(created.id, reviewed: stale)
                XCTFail("approval minted for files \(wrong.count) that don't match the draft")
            } catch APIError.conflict {}
        }
        let token = try await api.mintApproval(created.id, reviewed: reviewed)
        let receipt = try await api.approveAndSendReceipt(created.id, approvalToken: token)
        XCTAssertFalse(receipt.messageId.isEmpty)
        if let encryption = receipt.encryption { XCTAssertEqual(encryption, .tlsOnly, "pgp: off goes out over TLS") }
        let status = try await api.draft(created.id).draft.status
        XCTAssertEqual(status, .sent)
    }

    /// The app's default encryption (`pgp: auto`) with a file. The server encrypts as PGP/MIME when it holds an
    /// OpenPGP key for every recipient and sends over TLS otherwise; the app's requests are the same either way.
    func testAttachmentApproveAndSendAutoPGP() async throws {
        let api = try live()
        let stamp = ISO8601DateFormatter().string(from: Date())
        let subject = "LOJO Mail iOS attachments test, OpenPGP auto \(stamp)"
        let png = OutgoingAttachment(filename: "pixel.png", contentType: "image/png", data: Self.pixel)
        let created = try await api.createDraft(
            DraftFields(to: Self.testAddress, subject: subject, text: "One file, encryption on Auto, sent by the LOJO Mail iOS test suite. Safe to trash.", pgp: .auto),
            threadId: nil, inReplyTo: nil)
        do {
            let view = try await api.addDraftAttachment(created.id, png)
            let reviewed = DraftFields(view)
            XCTAssertEqual(reviewed.pgp, .auto)
            let token = try await api.mintApproval(created.id, reviewed: reviewed)
            let receipt = try await api.approveAndSendReceipt(created.id, approvalToken: token)
            if let encryption = receipt.encryption { XCTAssertNotEqual(encryption, .pgpInline, "a draft with files is PGP/MIME when encrypted") }
            print("live-write: pgp auto with a file went out as \(receipt.encryption?.rawValue ?? "unreported (server without the encryption field)")")
        } catch {
            _ = try? await api.discard(created.id)
            throw error
        }
        let sentFolder = try await api.folder(.sent, limit: 25)
        let copy = try XCTUnwrap(sentFolder.first { $0.subject == subject }, "the Sent copy")
        XCTAssertEqual(copy.attachments.map(\.filename), ["pixel.png"])
        // The Sent copy is stored in the clear either way, so it can't say whether the wire copy was encrypted.
        print("live-write: sent 1 file with pgp auto to \(Self.testAddress)")
    }

}
