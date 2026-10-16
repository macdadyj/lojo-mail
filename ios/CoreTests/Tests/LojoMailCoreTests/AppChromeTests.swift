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
        XCTAssertEqual(AppChrome.reviewMenuLabel(waiting: 0), "Approval queue")
        XCTAssertEqual(AppChrome.reviewMenuLabel(waiting: 2), "Approval queue (2)")
        XCTAssertEqual(AppChrome.reviewBanner(waiting: 1), "1 draft waiting in the approval queue")
        XCTAssertEqual(AppChrome.reviewBanner(waiting: 3), "3 drafts waiting in the approval queue")
        XCTAssertTrue(AppChrome.reviewSettingsDetail(waiting: 0).contains("SI"))
        XCTAssertFalse(AppChrome.reviewSettingsDetail(waiting: 4).contains("AI"))
        XCTAssertTrue(AppChrome.reviewSettingsDetail(waiting: 4).contains("4"))
    }

    func testBuildLabel() {
        XCTAssertEqual(AppBuild.label(info: ["CFBundleShortVersionString": "0.1", "CFBundleVersion": "11"]), "Version 0.1 (build 11)")
        XCTAssertEqual(AppBuild.label(info: ["CFBundleShortVersionString": "0.1", "CFBundleVersion": " 15.3 "]), "Version 0.1 (build 15.3)")
        XCTAssertEqual(AppBuild.label(info: ["CFBundleShortVersionString": "  ", "CFBundleVersion": ""]), "Version 0.1 (build 2)")
        XCTAssertEqual(AppBuild.label(info: ["CFBundleShortVersionString": "$(MARKETING_VERSION)", "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)"]), "Version 0.1 (build 2)")
        XCTAssertEqual(AppBuild.label(info: nil), "Version 0.1 (build 2)")
    }

    func testLaunchHooksNeverEnableTestModeOrDropTheKey() {
        let screens: [String?] = ["inbox", "thread", "attachment", "compose", "sendconfirm", "review", "draft", "rules", "settings", "search", "signin", "key", "folder", "uitest", "", nil]
        for screen in screens {
            XCTAssertFalse(LaunchSideEffects.enablesTestMode(screen: screen), "screen \(screen ?? "nil")")
            XCTAssertFalse(LaunchSideEffects.discardsEnvelopeKey(screen: screen), "screen \(screen ?? "nil")")
        }
        XCTAssertFalse(LaunchSideEffects.writesEnvelopeKey(uiTest: false))
        XCTAssertFalse(LaunchSideEffects.persistsUITestSession(uiTest: false))
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
