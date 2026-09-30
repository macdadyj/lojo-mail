import Foundation
import XCTest
@testable import LojoMailCore

/// The app's mail actions against the deployed API, through the same `APIClient` the app uses. Opt-in twice over:
/// `LOJO_LIVE_WRITE=1` on top of the live session (`scripts/test-core.sh --live-write`). It only touches mail from or to
/// `lojo-test@cyberphysical.us`, sends at most one real message (to that address), and puts every flag, folder and
/// switch back the way it found it.
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
}
