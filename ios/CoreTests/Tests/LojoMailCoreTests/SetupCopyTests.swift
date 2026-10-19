import XCTest
@testable import LojoMailCore

final class SetupCopyTests: XCTestCase {
    func testSetupUsesPlainWordsForAccountSiAndApprovals() {
        XCTAssertEqual(SetupCopy.accountLabel, "Account")
        XCTAssertTrue(SetupCopy.accountDetail.contains("mailbox"))
        XCTAssertEqual(SetupCopy.siTitle, "SI")
        XCTAssertTrue(SetupCopy.siDetail.contains("Filter with SI"))
        XCTAssertTrue(SetupCopy.siDetail.contains("Reply with SI"))
        XCTAssertTrue(SetupCopy.siDetail.contains("Approve and send"))
        XCTAssertEqual(SetupCopy.approvalsTitle, "Approval queue")
        XCTAssertTrue(SetupCopy.approvalsDetail.contains("Approve and send"))
        XCTAssertEqual(SetupCopy.steps.count, 3)
        let joined = ([SetupCopy.accountDetail, SetupCopy.siDetail, SetupCopy.approvalsDetail] + SetupCopy.steps).joined(separator: " ")
        XCTAssertFalse(joined.contains("AI"))
        XCTAssertFalse(joined.localizedCaseInsensitiveContains("test mode"))
    }
}
