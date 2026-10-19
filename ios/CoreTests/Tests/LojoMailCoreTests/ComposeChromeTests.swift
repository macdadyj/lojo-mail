import XCTest
@testable import LojoMailCore

final class ComposeChromeTests: XCTestCase {
    func testFieldOrderWalksToThenCcThenSubjectThenMessage() {
        XCTAssertEqual(ComposeChrome.nextField(.to), .cc)
        XCTAssertEqual(ComposeChrome.nextField(.cc), .subject)
        XCTAssertEqual(ComposeChrome.nextField(.subject), .body)
        XCTAssertNil(ComposeChrome.nextField(.body))
        XCTAssertNil(ComposeChrome.nextField(nil))
        XCTAssertEqual(ComposeChrome.previousField(.body), .subject)
        XCTAssertEqual(ComposeChrome.previousField(.subject), .cc)
        XCTAssertEqual(ComposeChrome.previousField(.cc), .to)
        XCTAssertNil(ComposeChrome.previousField(.to))
        XCTAssertEqual(ComposeField.allCases.map(\.accessibilityLabel), ["To", "Cc", "Subject", "Message"])
    }

    func testEditorGrowsForAccessibilitySizesAndDoesNotSend() {
        XCTAssertGreaterThan(ComposeChrome.editorMinHeight(accessibilitySize: true), ComposeChrome.editorMinHeight(accessibilitySize: false))
        XCTAssertGreaterThan(ComposeChrome.bodyLineSpacing, 0)
        XCTAssertEqual(ComposeChrome.placeholder, "Write your message")
        XCTAssertFalse(ComposeChrome.approvalNote.localizedCaseInsensitiveContains("auto-send"))
        XCTAssertTrue(ComposeChrome.approvalNote.contains("approve"))
    }
}
