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

    func testActionBarKeepsSiBesideReply() {
        XCTAssertEqual(SiEntry.actionBar, ["Reply", "Reply with SI", "Filter with SI"])
        XCTAssertEqual(SiEntry.icon, "sparkles")
        XCTAssertEqual(SiDirectChoice.allCases.map(\.title), [
            "Filter to Spam", "Filter to Label…", "Block sender", "Move to Trash", "Let SI decide",
        ])
        XCTAssertFalse(SiDirectChoice.decide.appliesOnTap)
        XCTAssertTrue(SiDirectChoice.trash.appliesOnTap)
    }

    func testDirectChoicesStayInTrashAndHonorTheKillSwitch() {
        var sheet = SiMessageFilter(
            messageIds: ["m1", "m2"],
            from: "News@Northwind.example",
            domain: "Northwind.example",
            subject: "Notes",
            existingLabels: ["family", "flagged", "Church"]
        )
        XCTAssertEqual(sheet.from, "news@northwind.example")
        XCTAssertEqual(sheet.proposals(for: .spam).map(\.actions.first?.type), ["spam", "spam"])
        XCTAssertEqual(sheet.proposals(for: .spam).map(\.saveRule), [false, false])
        sheet.saveForFuture = true
        XCTAssertEqual(sheet.proposals(for: .trash).first?.actions.map(\.type), ["trash"])
        XCTAssertEqual(sheet.proposals(for: .trash).first?.saveRule, true)
        XCTAssertEqual(sheet.proposals(for: .blockSender).first?.actions.map(\.type), ["blockSender"])
        XCTAssertTrue(sheet.proposals(for: .decide).isEmpty)
        let types = SiDirectChoice.allCases.flatMap { choice in
            sheet.proposals(for: choice).flatMap { proposal in proposal.actions.map { $0.type } }
        }
        XCTAssertFalse(types.contains("delete") || types.contains("hardDelete") || types.contains("purge"))
        sheet.killSwitch = true
        XCTAssertTrue(SiDirectChoice.allCases.allSatisfy { sheet.proposals(for: $0).isEmpty })
    }

    func testLabelChipsUseTheSuggestionAndRejectABadName() {
        var sheet = SiMessageFilter(messageIds: ["m1"], from: "a@b.example", domain: "b.example", subject: "Receipt", existingLabels: ["family", "flagged", "Church"])
        sheet.useSuggestion("Receipts")
        XCTAssertEqual(sheet.labelChips, ["receipts", "family", "church"])
        XCTAssertTrue(sheet.isSuggested("receipts"))
        XCTAssertEqual(sheet.proposals(for: .label).first?.actions.first?.labels, ["receipts"])
        sheet.makingNewLabel = true
        sheet.customLabel = "  Church Group "
        XCTAssertEqual(sheet.proposals(for: .label).first?.actions.first?.labels, ["church group"])
        sheet.customLabel = "flagged"
        XCTAssertTrue(sheet.proposals(for: .label).isEmpty)
        sheet.customLabel = ""
        XCTAssertTrue(sheet.proposals(for: .label).isEmpty)
        sheet.saveForFuture = false
        XCTAssertTrue(sheet.proposals(for: .blockSender).isEmpty)
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
