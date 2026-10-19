import XCTest
@testable import LojoMailCore

final class ReadingTests: XCTestCase {
    func testLineLimitsGrowWithAccessibilitySizes() {
        XCTAssertEqual(MailReading.subjectLineLimit(accessibilitySize: false), 2)
        XCTAssertEqual(MailReading.snippetLineLimit(accessibilitySize: false), 2)
        XCTAssertGreaterThan(MailReading.subjectLineLimit(accessibilitySize: true), 2)
        XCTAssertGreaterThan(MailReading.snippetLineLimit(accessibilitySize: true), 2)
        XCTAssertGreaterThan(MailReading.bodyLineSpacing, 0)
        XCTAssertLessThan(MailReading.bodyLineSpacing, 16)
    }

    func testRowLabelLeadsWithUnreadAndSkipsEmptyPreview() {
        let label = MailReading.rowLabel(
            unread: true,
            sender: "Ada",
            count: 2,
            subject: " Gate ",
            snippet: "  ",
            starred: true,
            attachments: false
        )
        XCTAssertTrue(label.hasPrefix("Unread. Ada. 2 messages. Gate. Starred"))
        XCTAssertFalse(label.contains("test mode"))
        let read = MailReading.rowLabel(unread: false, sender: "Ada", count: 1, subject: "", snippet: "Hello", starred: false, attachments: true)
        XCTAssertEqual(read, "Ada. (no subject). Hello. Has attachments")
    }
}
