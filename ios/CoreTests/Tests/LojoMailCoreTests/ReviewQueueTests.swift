import XCTest
@testable import LojoMailCore

final class ReviewQueueTests: XCTestCase {
    func testOnlyPendingAndEditableBotDraftsCount() throws {
        let waiting = [
            try draft(status: "pending_approval", origin: "human"),
            try draft(status: "pending_approval", origin: "ai"),
            try draft(status: "suggested", origin: "ai"),
            try draft(status: "edited", origin: "agent"),
            try draft(status: "suggested", origin: "rule"),
        ]
        let ignored = [
            try draft(status: "suggested", origin: "human"),
            try draft(status: "edited", origin: "client"),
            try draft(status: "edited", origin: "human"),
            try draft(status: "sent", origin: "ai"),
            try draft(status: "discarded", origin: "rule"),
            try draft(status: "sending", origin: "agent"),
        ]
        for draft in waiting {
            XCTAssertTrue(ReviewQueue.needsAttention(draft), "\(draft.origin.rawValue) \(draft.status.rawValue)")
        }
        for draft in ignored {
            XCTAssertFalse(ReviewQueue.needsAttention(draft), "\(draft.origin.rawValue) \(draft.status.rawValue)")
        }
        XCTAssertEqual(ReviewQueue.count(waiting + ignored), waiting.count)
        XCTAssertEqual(ReviewQueue.count([]), 0)
    }

    func testFixtureQueueMatchesTheRuleAndSaysSI() throws {
        let views = try UITestFixtures.drafts()
        XCTAssertEqual(ReviewQueue.count(views.map(\.draft)), 1)
        let pending = try XCTUnwrap(views.first { $0.draft.status == .pendingApproval })
        XCTAssertEqual(pending.draft.origin, .ai)
        XCTAssertEqual(pending.draft.origin.chip, "SI")
        XCTAssertEqual(pending.draft.origin.writer, "SI")
        XCTAssertFalse(pending.draft.authorNotice?.contains("AI") ?? true)
        let sent = views.filter { $0.draft.status == .sent }
        XCTAssertEqual(sent.count, 1)
        XCTAssertFalse(ReviewQueue.needsAttention(sent[0].draft))
    }

    private func draft(status: String, origin: String) throws -> Draft {
        let json = """
        {"id":"d-\(status)-\(origin)","to":[],"cc":[],"subject":"Queue","status":"\(status)","origin":"\(origin)","pgp":"auto","createdAt":"2026-10-15T00:00:00.000Z","updatedAt":"2026-10-15T00:00:00.000Z"}
        """
        return try JSONDecoder().decode(Draft.self, from: Data(json.utf8))
    }
}
