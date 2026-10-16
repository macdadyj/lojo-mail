import XCTest

/// Walks every screen and the buttons Jon would tap. Does not turn on test mode and does not remove the key.
final class MailUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testTabsDoNotIncludeReview() {
        let app = launch()
        XCTAssertTrue(app.tabBars.buttons["Mail"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.tabBars.buttons["Rules"].exists)
        XCTAssertTrue(app.tabBars.buttons["Settings"].exists)
        XCTAssertFalse(app.tabBars.buttons["Review"].exists, "Review must not be a tab")
        XCTAssertFalse(app.tabBars.buttons["AI Rules"].exists, "Rules is not labeled AI")
        XCTAssertEqual(app.tabBars.buttons.count, 3)
        shot(app, "after-inbox")
    }

    func testInboxFoldersSearchComposeAndApprovalQueue() {
        let app = launch()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["mail.approval-queue.banner"].waitForExistence(timeout: 4))
        openFolder(app, "Sent")
        XCTAssertTrue(app.navigationBars["Sent"].waitForExistence(timeout: 4))
        openFolder(app, "Drafts")
        XCTAssertTrue(app.navigationBars["Drafts"].waitForExistence(timeout: 4))
        openFolder(app, "Junk")
        XCTAssertTrue(app.navigationBars["Junk"].waitForExistence(timeout: 4))
        openFolder(app, "Archive")
        XCTAssertTrue(app.navigationBars["Archive"].waitForExistence(timeout: 4))
        openFolder(app, "Trash")
        XCTAssertTrue(app.navigationBars["Trash"].waitForExistence(timeout: 4))
        openFolder(app, "Inbox")

        app.buttons["mail.more"].tap()
        XCTAssertTrue(app.buttons["Select messages"].waitForExistence(timeout: 3))
        app.buttons["Select messages"].tap()
        app.buttons["mail.more"].tap()
        if app.buttons["Done selecting"].waitForExistence(timeout: 3) {
            app.buttons["Done selecting"].tap()
        } else if app.buttons["mail.more"].exists {
            app.buttons["mail.more"].tap()
        }

        let compose = composeButton(app)
        XCTAssertTrue(compose.waitForExistence(timeout: 6), "New message is not in the toolbar")
        compose.tap()
        XCTAssertTrue(app.navigationBars["New message"].waitForExistence(timeout: 6) || app.navigationBars.element.waitForExistence(timeout: 6))
        dismissCompose(app)

        app.swipeDown()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 4), "Search field did not appear")
        search.tap()
        search.typeText("Gate")
        XCTAssertTrue(matching(app, "mail.row.thr_uitest_gate").waitForExistence(timeout: 4))
        dismissSearch(app)
        shot(app, "after-compose-closed")

        openApprovalQueue(app)
        XCTAssertTrue(app.navigationBars["Approval queue"].waitForExistence(timeout: 6))
        let explanation = app.descendants(matching: .any)["review.explanation"]
        XCTAssertTrue(explanation.waitForExistence(timeout: 3))
        XCTAssertTrue(explanation.label.contains("Approve and send"))
        XCTAssertFalse(explanation.label.contains("AI"))
        XCTAssertTrue(app.descendants(matching: .any)["review.row.drf_uitest_queue"].waitForExistence(timeout: 4))
        app.descendants(matching: .any)["review.row.drf_uitest_queue"].firstMatch.tap()
        dismissCompose(app)
        XCTAssertTrue(app.buttons["review.done"].waitForExistence(timeout: 4))
        app.buttons["review.done"].tap()
        shot(app, "after-approval-queue")
    }

    func testThreadKeepsSiBesideReply() {
        let app = launch()
        let row = matching(app, "mail.row.thr_uitest_gate")
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.action-bar"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["thread.reply"].waitForExistence(timeout: 4))
        revealBarButton(app, "si.reply")
        revealBarButton(app, "si.filter.message")
        XCTAssertEqual(app.buttons["si.reply"].label, "Reply with SI")
        XCTAssertEqual(app.buttons["si.filter.message"].label, "Filter with SI")
        shot(app, "after-thread")

        app.buttons["si.reply"].tap()
        XCTAssertTrue(app.navigationBars["Reply with SI"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.buttons["si.tone.brief"].waitForExistence(timeout: 3))
        app.buttons["si.tone.brief"].tap()
        app.buttons["si.tone.formal"].tap()
        app.buttons["si.tone.warm"].tap()
        app.buttons["si.tone.direct"].tap()
        app.buttons["si.tone.friendly"].tap()
        if app.descendants(matching: .any)["si.reply.instruction"].waitForExistence(timeout: 2) {
            app.descendants(matching: .any)["si.reply.instruction"].tap()
            app.descendants(matching: .any)["si.reply.instruction"].typeText("say yes")
        }
        app.buttons["si.reply.generate"].firstMatch.tap()
        let cancelDraft = app.buttons["compose.cancel"].firstMatch
        XCTAssertTrue(cancelDraft.waitForExistence(timeout: 8))
        cancelDraft.tap()
        if app.buttons["Close without saving"].waitForExistence(timeout: 2) {
            app.buttons["Close without saving"].tap()
        }
        shot(app, "after-si-reply")

        let filterMessage = matching(app, "si.filter.message")
        XCTAssertTrue(filterMessage.waitForExistence(timeout: 6))
        filterMessage.tap()
        XCTAssertTrue(app.descendants(matching: .any)["si.direct.sheet"].firstMatch.waitForExistence(timeout: 8))
        let spam = app.buttons["Filter to Spam"].firstMatch
        if !spam.waitForExistence(timeout: 2) { app.swipeUp() }
        XCTAssertTrue(spam.waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["Block sender"].firstMatch.exists)
        XCTAssertTrue(app.buttons["Move to Trash"].firstMatch.exists)
        app.buttons["si.direct.decide"].tap()
        if app.buttons["Close"].waitForExistence(timeout: 4) {
            app.buttons["Close"].tap()
        }
        if app.buttons["Close"].waitForExistence(timeout: 3) {
            app.buttons["Close"].tap()
        }
        shot(app, "after-si-filter")

        app.buttons["thread.reply"].tap()
        dismissCompose(app)

        if app.buttons["Star"].waitForExistence(timeout: 2) || app.buttons["Unstar"].waitForExistence(timeout: 1) {
            (app.buttons["Star"].exists ? app.buttons["Star"] : app.buttons["Unstar"]).tap()
        }
        if app.buttons["More actions"].waitForExistence(timeout: 3) {
            app.buttons["More actions"].tap()
            if app.buttons["Mark as unread"].waitForExistence(timeout: 2) {
                app.navigationBars.firstMatch.tap()
            }
        }
        app.navigationBars.buttons.firstMatch.tap()
    }

    func testRulesAndSettingsWithoutEnablingTestModeOrRemovingTheKey() {
        let app = launch()
        XCTAssertTrue(app.tabBars.buttons["Rules"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Rules"].tap()
        XCTAssertTrue(app.navigationBars["Rules"].waitForExistence(timeout: 6))
        XCTAssertFalse(app.staticTexts["AI Rules"].exists)
        XCTAssertTrue(app.buttons["rules.kill-switch"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.buttons["rules.kill-switch"].label.contains("autonomous"))
        app.buttons["rules.kill-switch"].tap()
        XCTAssertTrue(app.buttons["Release kill switch"].waitForExistence(timeout: 4))
        shot(app, "after-rules")

        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.buttons["settings.approval-queue"].waitForExistence(timeout: 4))
        let loadKey = app.buttons["Load envelope key…"]
        XCTAssertTrue(reveal(loadKey, in: app), "Load envelope key is missing")
        XCTAssertFalse(app.buttons["Replace key…"].exists, "UI tests must not load a key")
        loadKey.tap()
        XCTAssertTrue(app.navigationBars["Unlock your mail"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.buttons["unlock.files"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["unlock.paste"].exists)
        XCTAssertTrue(app.buttons["unlock.airdrop"].exists)
        XCTAssertTrue(reveal(app.buttons["unlock.share"], in: app), "Share or Open in is missing")
        XCTAssertTrue(reveal(app.buttons["unlock.usb"], in: app), "USB from Santa Computa is missing")
        XCTAssertTrue(reveal(app.buttons["unlock.save"], in: app), "Save to Keychain is missing")
        app.buttons["Later"].tap()
        XCTAssertFalse(app.alerts["Remove the envelope key?"].exists)

        let testMode = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Test mode'")).firstMatch
        XCTAssertTrue(reveal(testMode, in: app), "test mode toggle missing")
        XCTAssertEqual(testMode.value as? String, "0", "UI tests must not turn test mode on")
        XCTAssertFalse(app.buttons["testmode.off"].exists)

        let build = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Version '")).firstMatch
        XCTAssertTrue(reveal(build, in: app, swipes: 8), "Settings does not show the build")
        XCTAssertTrue(build.label.contains("build"), "unexpected build line: \(build.label)")
        shot(app, "after-settings")

        XCTAssertTrue(revealUp(app.buttons["settings.approval-queue"], in: app), "Approval queue row is missing")
        app.buttons["settings.approval-queue"].tap()
        XCTAssertTrue(app.navigationBars["Approval queue"].waitForExistence(timeout: 6))
        app.buttons["review.done"].tap()

        XCTAssertTrue(reveal(app.buttons["Blocked"], in: app))
        app.buttons["Blocked"].tap()
        XCTAssertTrue(app.navigationBars["Blocked"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["si.unblock.si-block-sender-news"].waitForExistence(timeout: 3))
        app.navigationBars.buttons.firstMatch.tap()

        XCTAssertTrue(reveal(app.buttons["Saved SI filters"], in: app))
        app.buttons["Saved SI filters"].tap()
        XCTAssertTrue(app.navigationBars["SI filters"].waitForExistence(timeout: 4))
        app.navigationBars.buttons.firstMatch.tap()

        XCTAssertTrue(reveal(app.buttons["Filter the inbox with SI"], in: app))
        app.buttons["Filter the inbox with SI"].tap()
        XCTAssertTrue(app.buttons["Close"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.navigationBars["Filter with SI"].exists)
        app.buttons["Close"].tap()

        XCTAssertEqual(app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Test mode'")).firstMatch.value as? String, "0")
    }

    func testSignInAndKeySetupScreens() {
        let app = launch(extra: ["-LojoMailUITestScreen", "signin"])
        XCTAssertTrue(app.staticTexts["LOJO Mail"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["signin.submit"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.buttons["signin.submit"].isEnabled, "Sign in stays disabled with an empty passphrase")
        XCTAssertTrue(app.textFields["Account"].exists)
        shot(app, "after-sign-in")
    }

    func testToolbarFilterWithSI() {
        let app = launch()
        XCTAssertTrue(app.buttons["si.filter"].waitForExistence(timeout: 8))
        XCTAssertEqual(app.buttons["si.filter"].label, "Filter with SI")
        app.buttons["si.filter"].tap()
        XCTAssertTrue(app.buttons["Close"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.navigationBars["Filter with SI"].exists)
        XCTAssertTrue(app.buttons["si.apply-all"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts["Weekly notes"].waitForExistence(timeout: 3))
        app.buttons["Close"].tap()
    }

    private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-LojoMailUITest"] + extra
        app.launch()
        return app
    }

    private func openFolder(_ app: XCUIApplication, _ title: String) {
        XCTAssertTrue(app.buttons["mail.folders"].waitForExistence(timeout: 4))
        app.buttons["mail.folders"].tap()
        let exact = app.buttons[title]
        if exact.waitForExistence(timeout: 3) {
            exact.tap()
            return
        }
        let prefixed = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        XCTAssertTrue(prefixed.waitForExistence(timeout: 2), "Folder \(title) is missing")
        prefixed.tap()
    }

    @discardableResult
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 5) -> Bool {
        scroll(element, in: app, swipes: swipes, down: false)
    }

    @discardableResult
    private func revealUp(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 6) -> Bool {
        scroll(element, in: app, swipes: swipes, down: true)
    }

    private func scroll(_ element: XCUIElement, in app: XCUIApplication, swipes: Int, down: Bool) -> Bool {
        if element.exists { return true }
        for _ in 0..<swipes {
            if down { app.swipeDown() } else { app.swipeUp() }
            if element.waitForExistence(timeout: 1) { return true }
        }
        return element.exists
    }

    private func revealBarButton(_ app: XCUIApplication, _ identifier: String) {
        let button = app.buttons[identifier]
        if button.waitForExistence(timeout: 4), button.isHittable { return }
        let bar = app.descendants(matching: .any)["thread.action-bar"]
        bar.swipeLeft()
        XCTAssertTrue(button.waitForExistence(timeout: 3), "\(identifier) is missing from the action bar")
    }

    private func dismissSearch(_ app: XCUIApplication) {
        for _ in 0..<3 {
            if app.buttons["mail.compose"].exists { return }
            let cancel = app.buttons["Cancel"].firstMatch
            if cancel.exists {
                cancel.tap()
                continue
            }
            app.swipeDown()
        }
    }

    private func composeButton(_ app: XCUIApplication) -> XCUIElement {
        let identified = app.buttons["mail.compose"].firstMatch
        if identified.exists { return identified }
        return app.buttons["New message"].firstMatch
    }

    /// The first hittable element with this identifier. SwiftUI often exposes the same id twice.
    private func matching(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        let matches = app.descendants(matching: .any).matching(identifier: identifier)
        for index in 0..<matches.count {
            let element = matches.element(boundBy: index)
            if element.isHittable { return element }
        }
        return matches.firstMatch
    }

    private func dismissCompose(_ app: XCUIApplication) {
        if app.buttons["compose.cancel"].waitForExistence(timeout: 4) {
            app.buttons["compose.cancel"].tap()
        } else if app.buttons["Cancel"].waitForExistence(timeout: 2) {
            app.buttons["Cancel"].tap()
        } else if app.buttons["Close"].waitForExistence(timeout: 2) {
            app.buttons["Close"].tap()
        } else if app.buttons["Done"].waitForExistence(timeout: 2) {
            app.buttons["Done"].tap()
        }
        if app.buttons["Close without saving"].waitForExistence(timeout: 2) {
            app.buttons["Close without saving"].tap()
        }
    }

    private func openApprovalQueue(_ app: XCUIApplication) {
        if app.buttons["mail.approval-queue.banner"].waitForExistence(timeout: 3) {
            app.buttons["mail.approval-queue.banner"].tap()
            return
        }
        app.buttons["mail.more"].tap()
        let item = app.descendants(matching: .any)["mail.approval-queue"]
        if item.waitForExistence(timeout: 3) {
            item.tap()
            return
        }
        if app.buttons["Approval queue"].waitForExistence(timeout: 2) {
            app.buttons["Approval queue"].tap()
        }
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let root = ProcessInfo.processInfo.environment["LOJO_UI_SCREENSHOTS"] {
            let url = URL(fileURLWithPath: root).appendingPathComponent("\(name).png")
            try? app.screenshot().pngRepresentation.write(to: url)
        }
    }
}
