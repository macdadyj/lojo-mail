import Foundation
import XCTest
@testable import LojoMailCore

final class AttachmentTests: XCTestCase {
    func testBase64SizeMatchesFoundation() {
        for bytes in [0, 1, 2, 3, 57, 58, 1_000, 999_999, 3_000_000] {
            let encoded = Data(repeating: 0xAB, count: bytes).base64EncodedString(options: [.lineLength76Characters, .endLineWithCarriageReturn, .endLineWithLineFeed])
            let withFinalBreak = encoded.utf8.count + (bytes > 0 ? 2 : 0)
            XCTAssertEqual(AttachmentBudget.encodedSize(bytes), withFinalBreak, "\(bytes) bytes")
        }
    }

    func testFourMegabyteBudget() {
        let budget = AttachmentBudget()
        XCTAssertTrue(budget.fits(textBytes: 2_000, attachmentSizes: [2_500_000]))
        XCTAssertFalse(budget.fits(textBytes: 2_000, attachmentSizes: [3_000_000]), "3 MB raw is over 4 MB once encoded")
        XCTAssertFalse(budget.fits(textBytes: 0, attachmentSizes: Array(repeating: 10, count: 11)), "file count")
        let room = budget.remainingRawBytes(textBytes: 2_000, attachmentSizes: [1_000_000])
        XCTAssertTrue(budget.fits(textBytes: 2_000, attachmentSizes: [1_000_000, room]))
        XCTAssertFalse(budget.fits(textBytes: 2_000, attachmentSizes: [1_000_000, room + 20_000]))
        XCTAssertEqual(budget.remainingRawBytes(textBytes: 0, attachmentSizes: [2_990_000]), 0)
        XCTAssertGreaterThan(budget.usage(textBytes: 0, attachmentSizes: [2_000_000]), 0.6)
        XCTAssertEqual(AttachmentBudget(DraftAttachmentSupport(maxMessageBytes: 10_000_000, maxFiles: 3)).maxFiles, 3)
        XCTAssertEqual(AttachmentBudget(nil).maxMessageBytes, 4_000_000)
    }

    func testOutgoingAttachmentHashAndName() {
        let file = OutgoingAttachment(filename: "../../etc/pa\u{0}ss\"wd.txt", contentType: "", data: Data("abc".utf8))
        XCTAssertEqual(file.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(file.filename, "passwd.txt")
        XCTAssertEqual(file.contentType, "application/octet-stream")
        XCTAssertEqual(OutgoingAttachment.cleanFilename(".."), "attachment")
        XCTAssertEqual(OutgoingAttachment.cleanFilename("  Photo 1.jpg "), "Photo 1.jpg")
        XCTAssertEqual(OutgoingAttachment.cleanFilename(String(repeating: "a", count: 300)).count, 120)
    }

    func testApprovalNamesAttachmentsOnlyWhenThereAreSome() throws {
        let plain = DraftFields(to: "a@x.com", subject: "S", text: "T")
        XCTAssertNil(plain.approvalPayload["attachments"], "today's server rejects unknown members")
        let json = """
        {"draft":{"id":"drf_1","to":[{"email":"a@x.com"}],"cc":[],"subject":"S","status":"edited","origin":"human","pgp":"auto","createdAt":"2026-09-30T00:00:00Z","updatedAt":"2026-09-30T00:00:00Z","attachments":[{"id":"a1","filename":"p.jpg","contentType":"image/jpeg","size":3,"sha256":"ba78"}]},"text":"T"}
        """
        let view = try JSONDecoder().decode(DraftView.self, from: Data(json.utf8))
        let fields = DraftFields(view)
        XCTAssertEqual(fields.attachments, ["ba78"])
        XCTAssertEqual(fields.approvalPayload["attachments"] as? [String], ["ba78"])
        XCTAssertEqual(plain.changed(comparedTo: DraftFields(to: "a@x.com", subject: "S", text: "T", attachments: ["ba78"])), ["attachments"])
        XCTAssertNil(fields.payload["attachments"], "create/update never carry files")
    }

    func testSettingsAdvertiseDraftAttachments() throws {
        let base = #""mailbox":"lojo@cyberphysical.us","domain":"cyberphysical.us","llmProvider":"grok","dailyTokenBudget":1,"budgetUsed":0,"unlocked":false,"dev":false,"principal":"human""#
        XCTAssertNil(try JSONDecoder().decode(ServerSettings.self, from: Data("{\(base)}".utf8)).draftAttachments)
        let newer = try JSONDecoder().decode(ServerSettings.self, from: Data("{\(base),\"draftAttachments\":{\"maxMessageBytes\":4000000,\"maxFiles\":10}}".utf8))
        XCTAssertEqual(newer.draftAttachments?.maxMessageBytes, 4_000_000)
    }

    func testAttachmentRoutes() throws {
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, token: "hs_t")
        let add = try client.request("POST", "/v1/drafts/drf_1/attachments", json: ["filename": "a"])
        XCTAssertEqual(add.url?.path, "/v1/drafts/drf_1/attachments")
        XCTAssertEqual(add.httpMethod, "POST")
    }

    func testByteSizes() {
        XCTAssertEqual(ByteSize.format(512), "512 bytes")
        XCTAssertEqual(ByteSize.format(119_624), "120 KB")
        XCTAssertEqual(ByteSize.format(2_400_000), "2.4 MB")
        XCTAssertEqual(ByteSize.format(12_600_000), "13 MB")
    }
}
