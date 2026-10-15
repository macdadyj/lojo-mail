import XCTest
@testable import LojoMailCore

final class AppChromeTests: XCTestCase {
    func testTabsDoNotIncludeReview() {
        XCTAssertEqual(AppChrome.tabs, ["Mail", "Rules", "Settings"])
        XCTAssertFalse(AppChrome.tabs.contains("Review"))
        XCTAssertEqual(AppChrome.reviewTitle, "Approval queue")
        XCTAssertTrue(AppChrome.reviewExplanation.contains("Approve and send"))
        XCTAssertTrue(AppChrome.reviewExplanation.contains("SI"))
        XCTAssertFalse(AppChrome.reviewExplanation.contains("AI"))
    }

    func testBuildLabel() {
        XCTAssertEqual(AppBuild.label(info: ["CFBundleShortVersionString": "0.1", "CFBundleVersion": "11"]), "Version 0.1 (build 11)")
        XCTAssertEqual(AppBuild.label(info: ["CFBundleShortVersionString": "$(MARKETING_VERSION)", "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)"]), "Version 0.1 (build 2)")
        XCTAssertEqual(AppBuild.label(info: nil), "Version 0.1 (build 2)")
    }

    func testUITestFixturesNeverTouchTheKeyOrTestMode() {
        XCTAssertFalse(UITestFixtures.enablesTestMode)
        XCTAssertFalse(UITestFixtures.writesEnvelopeKey)
        XCTAssertFalse(UITestFixtures.deletesEnvelopeKey)
        XCTAssertFalse(UITestFixtures.persistsSession)
        XCTAssertFalse(LaunchSideEffects.enablesTestMode(screen: "uitest"))
        XCTAssertFalse(LaunchSideEffects.discardsEnvelopeKey(screen: "uitest"))
        XCTAssertFalse(LaunchSideEffects.writesEnvelopeKey(uiTest: true))
        XCTAssertFalse(LaunchSideEffects.persistsUITestSession(uiTest: true))
        XCTAssertTrue(UITestFixtures.session().isValid())
        XCTAssertFalse(try UITestFixtures.inbox().isEmpty)
        XCTAssertEqual(try UITestFixtures.drafts().first?.draft.status, .pendingApproval)
        XCTAssertEqual(try UITestFixtures.settings().mailbox, "lojo@cyberphysical.us")
        XCTAssertFalse(try UITestFixtures.rules().rules.rules.isEmpty)
        XCTAssertFalse(UITestFixtures.filterResult().proposals.isEmpty)
    }
}
