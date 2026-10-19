import XCTest
@testable import LojoMailCore

final class InboxGesturesTests: XCTestCase {
    func testSwipeAndVoiceOverShareTheSameNames() throws {
        XCTAssertEqual(InboxGestures.archive, "Archive")
        XCTAssertEqual(InboxGestures.markRead(unread: true), "Mark as read")
        XCTAssertEqual(InboxGestures.markRead(unread: false), "Mark as unread")
        let joined = [InboxGestures.archive, InboxGestures.markRead(unread: true), InboxGestures.markRead(unread: false)].joined(separator: " ")
        XCTAssertFalse(joined.localizedCaseInsensitiveContains("test mode"))
        XCTAssertFalse(joined.contains("AI"))

        let view = try String(contentsOf: mailboxView(), encoding: .utf8)
        XCTAssertTrue(view.contains("InboxGestures.archive"))
        XCTAssertTrue(view.contains("InboxGestures.markRead"))
        XCTAssertTrue(view.contains("accessibilityAction(named:"))
        XCTAssertTrue(view.contains("si.filter.swipe"))
    }

    private func mailboxView() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("App/Sources/LojoMail/Views/MailboxView.swift")
    }
}
