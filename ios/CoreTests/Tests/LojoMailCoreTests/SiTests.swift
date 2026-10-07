import XCTest
@testable import LojoMailCore

final class SiUITests: XCTestCase {
    func testFilterScreenApplyAllAndOneRow() {
        var screen = SiFilterScreen(result: SiFilterResult(killSwitch: false, proposals: [
            proposal("m1", actions: [SiAction(type: "label", labels: ["receipts"])], saveRule: false),
            proposal("m2", actions: [SiAction(type: "trash")], saveRule: true),
            proposal("m3", actions: [], saveRule: false),
        ]))
        XCTAssertEqual(Set(screen.applyAll.map(\.messageId)), ["m1", "m2"])
        XCTAssertTrue(screen.canApply)
        XCTAssertEqual(screen.applyOne("m2").map(\.messageId), ["m2"])
        XCTAssertTrue(screen.applyOne("m3").isEmpty)
        screen.toggle("m1")
        XCTAssertEqual(screen.applyAll.map(\.messageId), ["m2"])
        screen.setSaveRule("m1", true)
        XCTAssertEqual(screen.proposals.first { $0.messageId == "m1" }?.saveRule, true)
    }

    func testKillSwitchBlocksApply() {
        let screen = SiFilterScreen(result: SiFilterResult(killSwitch: true, proposals: [
            proposal("m1", actions: [SiAction(type: "spam")], saveRule: false),
        ]))
        XCTAssertFalse(screen.canApply)
        XCTAssertTrue(screen.applyAll.isEmpty)
        XCTAssertTrue(screen.applyOne("m1").isEmpty)
    }

    func testHardDeleteIsNotApplied() {
        let row = proposal("m1", actions: [SiAction(type: "delete"), SiAction(type: "trash")], saveRule: false)
        XCTAssertEqual(row.forApply.actions.map(\.type), ["trash"])
        let screen = SiFilterScreen(result: SiFilterResult(killSwitch: false, proposals: [
            proposal("gone", actions: [SiAction(type: "hardDelete")], saveRule: false),
        ]))
        XCTAssertTrue(screen.applyAll.isEmpty)
        XCTAssertFalse(screen.canApply)
    }

    func testReplyScreenNeverSendsAndOpensCompose() {
        var screen = SiReplyScreen(tone: .brief, instruction: "say yes, propose Tuesday")
        XCTAssertFalse(screen.sendsAutomatically)
        XCTAssertTrue(screen.opensInCompose)
        XCTAssertTrue(screen.canGenerate)
        XCTAssertEqual(SiTone.allCases.map(\.title), ["Friendly", "Brief", "Formal", "Warm", "Direct"])
        screen.instruction = String(repeating: "a", count: 501)
        XCTAssertFalse(screen.canGenerate)
    }

    func testActionSummariesAndLabelFolders() {
        XCTAssertEqual(SiAction(type: "trash").summary(from: "a@b.example", domain: "b.example"), "Move to Trash")
        XCTAssertEqual(SiAction(type: "blockSender").summary(from: "news@northwind.example", domain: "northwind.example"), "Block news@northwind.example")
        XCTAssertEqual(SiAction(type: "blockDomain").summary(from: "a@b.example", domain: "b.example"), "Block @b.example")
        XCTAssertEqual(SiAction(type: "label", labels: ["church", "family"]).summary(from: "", domain: ""), "Label Church, Family")
        XCTAssertEqual(SiLabels.suggested, ["receipts", "newsletters", "church", "family", "work"])
        XCTAssertEqual(SiLabels.title("work"), "Work")
    }

    func testDecodesAFilterResultAndABlock() throws {
        let filter = try JSONDecoder().decode(SiFilterResult.self, from: Data(#"""
        {"killSwitch":false,"proposals":[{"messageId":"m","from":"news@northwind.example","domain":"northwind.example","subject":"Notes","reason":"Newsletter","actions":[{"type":"label","labels":["newsletters"]}],"saveRule":true}]}
        """#.utf8))
        XCTAssertEqual(filter.proposals.first?.actions.first?.labels, ["newsletters"])
        XCTAssertTrue(filter.proposals.first?.saveRule ?? false)
        let page = try JSONDecoder().decode(SiBlockedPage.self, from: Data(#"""
        {"blocked":[{"ruleId":"si-block-sender-news","kind":"sender","value":"news@northwind.example","name":"SI block"}],"changeId":"sic_1"}
        """#.utf8))
        XCTAssertEqual(page.blocked.first?.title, "news@northwind.example")
        XCTAssertEqual(page.changeId, "sic_1")
        let rules = try JSONDecoder().decode(RulesDocument.self, from: Data(#"{"paused":false,"killSwitch":false,"siKillSwitch":true,"rules":[]}"#.utf8))
        XCTAssertEqual(rules.siKillSwitch, true)
    }

    func testSiRulesAreRecognized() {
        var rule = Rule(id: "si-file-news", name: "SI file", enabled: true, actions: [], stop: nil, createdBy: nil, updatedAt: nil)
        XCTAssertTrue(rule.isSiRule)
        XCTAssertFalse(rule.isSiBlock)
        rule.id = "si-block-sender-news"
        XCTAssertTrue(rule.isSiBlock)
        rule.id = "keep"
        XCTAssertFalse(rule.isSiRule)
    }

    private func proposal(_ id: String, actions: [SiAction], saveRule: Bool) -> SiProposal {
        SiProposal(messageId: id, from: "news@northwind.example", domain: "northwind.example", subject: "Notes", reason: "Newsletter", actions: actions, saveRule: saveRule)
    }
}
