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
        XCTAssertEqual(app.tabBars.buttons.count, 3)
        shot(app, "after-inbox")
    }

    func testInboxFoldersSearchComposeAndApprovalQueue() {
        let app = launch()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["mail.approval-queue.banner"].waitForExistence(timeout: 4))
        openFolder(app, "Sent")
        XCTAssertTrue(app.navigationBars["Sent"].waitForExistence(timeout: 4))
        openFolder(app, "Junk")
        openFolder(app, "Trash")
        XCTAssertTrue(app.navigationBars["Trash"].waitForExistence(timeout: 4))
        openFolder(app, "Inbox")

        app.buttons["mail.more"].tap()
        XCTAssertTrue(app.buttons["Select messages"].waitForExistence(timeout: 3))
        app.buttons["Select messages"].tap()
        app.buttons["mail.more"].tap()
        if app.buttons["Done selecting"].waitForExistence(timeout: 3) {
            app.buttons["Done selecting"].tap()
        }

        let search = app.searchFields.firstMatch
        if search.waitForExistence(timeout: 3) {
            search.tap()
            search.typeText("Gate")
            if app.keyboards.buttons["Search"].waitForExistence(timeout: 2) {
                app.keyboards.buttons["Search"].tap()
            } else if app.buttons["Search"].waitForExistence(timeout: 1) {
                app.buttons["Search"].tap()
            }
            if app.buttons["Cancel"].waitForExistence(timeout: 2) {
                app.buttons["Cancel"].tap()
            }
        }

        app.buttons["mail.compose"].tap()
        XCTAssertTrue(app.navigationBars["New message"].waitForExistence(timeout: 6) || app.navigationBars.element.waitForExistence(timeout: 6))
        dismissCompose(app)
        shot(app, "after-compose-closed")

        openApprovalQueue(app)
        XCTAssertTrue(app.navigationBars["Approval queue"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.descendants(matching: .any)["review.explanation"].waitForExistence(timeout: 3))
        if app.descendants(matching: .any)["review.row.drf_uitest_queue"].waitForExistence(timeout: 4) {
            app.descendants(matching: .any)["review.row.drf_uitest_queue"].firstMatch.tap()
            dismissCompose(app)
        }
        if app.buttons["review.done"].waitForExistence(timeout: 4) {
            app.buttons["review.done"].tap()
        }
        shot(app, "after-approval-queue")
    }

    func testThreadKeepsSiBesideReply() {
        let app = launch()
        let row = app.descendants(matching: .any)["mail.row.thr_uitest_gate"]
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.action-bar"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["thread.reply"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["si.reply"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["si.filter.message"].waitForExistence(timeout: 2))
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
        app.buttons["si.reply.generate"].tap()
        dismissCompose(app)
        if app.buttons["Close"].waitForExistence(timeout: 2) {
            app.buttons["Close"].tap()
        }
        shot(app, "after-si-reply")

        XCTAssertTrue(app.buttons["si.filter.message"].waitForExistence(timeout: 4))
        app.buttons["si.filter.message"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["si.direct.sheet"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.buttons["si.direct.spam"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["si.direct.blockSender"].exists)
        XCTAssertTrue(app.buttons["si.direct.trash"].exists)
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
        XCTAssertTrue(app.buttons["rules.kill-switch"].waitForExistence(timeout: 6))
        app.buttons["rules.kill-switch"].tap()
        if app.buttons["Release kill switch"].waitForExistence(timeout: 4) {
            app.buttons["Release kill switch"].tap()
            if app.buttons["Cancel"].waitForExistence(timeout: 2) {
                app.buttons["Cancel"].tap()
            }
        }
        shot(app, "after-rules")

        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.buttons["settings.approval-queue"].waitForExistence(timeout: 4))
        let testMode = app.switches["testmode.toggle"]
        XCTAssertTrue(testMode.waitForExistence(timeout: 6), "test mode toggle missing")
        XCTAssertEqual(testMode.value as? String, "0", "UI tests must not turn test mode on")
        XCTAssertFalse(app.buttons["testmode.off"].exists)

        let build = app.staticTexts["settings.build"]
        if !build.waitForExistence(timeout: 3) {
            app.swipeUp()
        }
        XCTAssertTrue(build.waitForExistence(timeout: 4), "Settings does not show the build")
        XCTAssertTrue(build.label.contains("build"), "unexpected build line: \(build.label)")
        shot(app, "after-settings")

        if app.buttons["Load envelope key…"].waitForExistence(timeout: 2) || app.buttons["Replace key…"].waitForExistence(timeout: 1) {
            (app.buttons["Replace key…"].exists ? app.buttons["Replace key…"] : app.buttons["Load envelope key…"]).tap()
            XCTAssertTrue(app.navigationBars["Unlock your mail"].waitForExistence(timeout: 6))
            XCTAssertTrue(app.buttons["unlock.files"].waitForExistence(timeout: 3))
            XCTAssertTrue(app.buttons["unlock.paste"].exists)
            XCTAssertTrue(app.buttons["unlock.airdrop"].exists)
            XCTAssertTrue(app.buttons["unlock.share"].exists)
            XCTAssertTrue(app.buttons["unlock.usb"].exists)
            app.buttons["Later"].tap()
        }

        XCTAssertFalse(app.alerts["Remove the envelope key?"].exists)
        app.buttons["settings.approval-queue"].tap()
        XCTAssertTrue(app.navigationBars["Approval queue"].waitForExistence(timeout: 6))
        app.buttons["review.done"].tap()

        if app.buttons["Blocked"].waitForExistence(timeout: 3) {
            app.buttons["Blocked"].tap()
            XCTAssertTrue(app.navigationBars["Blocked"].waitForExistence(timeout: 4))
            app.navigationBars.buttons.firstMatch.tap()
        }
        if app.buttons["Saved SI filters"].waitForExistence(timeout: 3) {
            app.buttons["Saved SI filters"].tap()
            XCTAssertTrue(app.navigationBars["SI filters"].waitForExistence(timeout: 4))
            app.navigationBars.buttons.firstMatch.tap()
        }

        app.buttons["Filter the inbox with SI"].tap()
        if app.buttons["Close"].waitForExistence(timeout: 6) {
            app.buttons["Close"].tap()
        }

        XCTAssertEqual(app.switches["testmode.toggle"].value as? String, "0")
    }

    func testSignInAndKeySetupScreens() {
        let app = launch(extra: ["-LojoMailUITestScreen", "signin"])
        XCTAssertTrue(app.staticTexts["LOJO Mail"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["signin.submit"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.textFields["Account"].exists)
        shot(app, "after-sign-in")
    }

    func testToolbarFilterWithSI() {
        let app = launch()
        XCTAssertTrue(app.buttons["si.filter"].waitForExistence(timeout: 8))
        app.buttons["si.filter"].tap()
        if app.buttons["Close"].waitForExistence(timeout: 8) {
            XCTAssertTrue(app.navigationBars["Filter with SI"].exists)
            if app.buttons["si.apply-all"].waitForExistence(timeout: 2) {
                XCTAssertTrue(app.buttons["si.apply-all"].exists)
            }
            app.buttons["Close"].tap()
        }
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
        let button = app.buttons[title]
        if button.waitForExistence(timeout: 3) {
            button.tap()
        } else if app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch.waitForExistence(timeout: 2) {
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch.tap()
        }
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
