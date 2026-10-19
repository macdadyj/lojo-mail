import XCTest
@testable import LojoMailCore

final class ListStatesTests: XCTestCase {
    func testEveryListHasLoadingEmptyAndError() {
        for list in [MailList.inbox, .search, .approval] {
            XCTAssertFalse(ListStates.loading(list).isEmpty)
            let empty = ListStates.empty(list, mailbox: "ada@example.com")
            XCTAssertFalse(empty.title.isEmpty)
            XCTAssertFalse(empty.message.isEmpty)
            let failed = ListStates.failed(list)
            XCTAssertFalse(failed.title.isEmpty)
            XCTAssertTrue(failed.message.contains("try again"))
            XCTAssertFalse(failed.message.localizedCaseInsensitiveContains("test mode"))
        }
        XCTAssertEqual(ListStates.empty(.inbox, mailbox: "ada@example.com").message, "New mail to ada@example.com shows up here.")
        XCTAssertTrue(ListStates.empty(.approval).message.contains("Approve and send"))
        XCTAssertFalse(ListStates.empty(.search).message.contains("AI"))
        XCTAssertEqual(ListStates.tryAgain, "Try again")
    }
}
