import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
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

    /// Values from `encodedSize` / `estimatedMessageBytes` in packages/core/src/draft-attachments.ts, so the app's
    /// budget and the server's 413 agree.
    func testBudgetMatchesServerArithmetic() {
        XCTAssertEqual(AttachmentBudget.encodedSize(1), 6)
        XCTAssertEqual(AttachmentBudget.encodedSize(57), 78)
        XCTAssertEqual(AttachmentBudget.encodedSize(2_900_000), 3_968_424)
        let budget = AttachmentBudget()
        XCTAssertEqual(budget.estimatedMessageBytes(textBytes: 0, attachmentSizes: []), 2_048)
        XCTAssertEqual(budget.estimatedMessageBytes(textBytes: 1_234, attachmentSizes: [100, 2_000_000]), 2_741_413)
        XCTAssertEqual(budget.estimatedMessageBytes(textBytes: 50_000, attachmentSizes: [1_000_000, 1_000_000, 900_000]), 4_027_012)
        XCTAssertFalse(budget.fits(textBytes: 50_000, attachmentSizes: [1_000_000, 1_000_000, 900_000]), "the server answers 413 for this one")
    }

    func testSendReceiptDecodesWithAndWithoutEncryption() throws {
        let reported = try JSONDecoder().decode(SendReceipt.self, from: Data(#"{"messageId":"m1","encryption":"pgp-mime"}"#.utf8))
        XCTAssertEqual(reported.encryption, .pgpMime)
        XCTAssertTrue(reported.summary.contains("OpenPGP"))
        let clear = try JSONDecoder().decode(SendReceipt.self, from: Data(#"{"messageId":"m1","encryption":"none"}"#.utf8))
        XCTAssertEqual(clear.encryption, .tlsOnly)
        let older = try JSONDecoder().decode(SendReceipt.self, from: Data(#"{"messageId":"m1"}"#.utf8))
        XCTAssertNil(older.encryption)
        XCTAssertEqual(older.summary, "Sent.")
    }

    func testReviewedAttachmentsFollowUploadOrder() {
        let onDraft = [DraftAttachment(id: "datt_1", filename: "a", contentType: "text/plain", size: 1, sha256: "aa")]
        let first = OutgoingAttachment(filename: "b", contentType: "text/plain", data: Data("b".utf8))
        let second = OutgoingAttachment(filename: "c", contentType: "text/plain", data: Data("c".utf8))
        XCTAssertEqual(DraftFields.reviewedAttachments(onDraft: onDraft, pending: [first, second]), ["aa", first.sha256, second.sha256])
    }

    func testTooLargeAndLimitErrorsAreClear() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, token: "hs_t", session: URLSession(configuration: config))
        let file = OutgoingAttachment(filename: "big.bin", contentType: "application/octet-stream", data: Data(count: 10))

        StubProtocol.reply = (413, #"{"error":"With this file the message would be about 4100000 bytes encoded, over the 4000000-byte limit"}"#)
        do {
            _ = try await client.addDraftAttachment("drf_1", file)
            XCTFail("413 accepted")
        } catch let error as APIError {
            guard case .tooLarge = error else { return XCTFail("\(error)") }
            XCTAssertTrue(error.localizedDescription.contains("4000000-byte limit"), error.localizedDescription)
            XCTAssertTrue(error.localizedDescription.contains("Remove a file"))
        }

        StubProtocol.reply = (400, #"{"error":"A draft can carry at most 10 files"}"#)
        do {
            _ = try await client.addDraftAttachment("drf_1", file)
            XCTFail("400 accepted")
        } catch APIError.invalid(let message) {
            XCTAssertEqual(message, "A draft can carry at most 10 files")
        }
        let body = try XCTUnwrap(StubProtocol.lastBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["sha256"] as? String, file.sha256)
        XCTAssertEqual(json["data"] as? String, file.data.base64EncodedString())
        XCTAssertEqual(StubProtocol.lastPath, "/v1/drafts/drf_1/attachments")
    }

}

/// Answers every request with `reply` and records the last request, for status-code mapping tests.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var reply: (Int, String) = (200, "{}")
    nonisolated(unsafe) static var lastBody: Data?
    nonisolated(unsafe) static var lastPath: String?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        StubProtocol.lastPath = request.url?.path
        StubProtocol.lastBody = request.httpBody ?? request.httpBodyStream.map(Self.read)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.reply.0, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.reply.1.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
