import Foundation
import XCTest
@testable import LojoMailCore

/// Envelopes come from `make-vectors.ts`, sealed by `packages/core/src/crypto/envelope.ts`. `LOJO_VECTORS` names the directory.
final class EnvelopeTests: XCTestCase {
    private func vectors() throws -> URL {
        guard let dir = ProcessInfo.processInfo.environment["LOJO_VECTORS"] else {
            throw XCTSkip("LOJO_VECTORS is not set; run ios/scripts/test-core.sh")
        }
        return URL(fileURLWithPath: dir)
    }

    private func key(_ name: String) throws -> Envelope.PrivateKey {
        try Envelope.PrivateKey(pasted: String(contentsOf: vectors().appendingPathComponent(name), encoding: .utf8))
    }

    func testOpensBodySealedByTheProcessor() throws {
        struct Body: Decodable { var id: String; var envelope: Envelope.Blob }
        let body = try JSONDecoder().decode(Body.self, from: Data(contentsOf: vectors().appendingPathComponent("body.json")))
        let opened = try Envelope.openJSON(SealedBody.self, body.envelope, with: key("key.jwk"), context: Envelope.messageBodyContext(body.id))
        let expected = try JSONDecoder().decode(SealedBody.self, from: Data(contentsOf: vectors().appendingPathComponent("body-expected.json")))
        XCTAssertEqual(opened, expected)
        XCTAssertTrue(opened.text.contains("Ünïcödé"))
        XCTAssertEqual(opened.ai?.summary, "Gate sensor back online.")
    }

    func testOpensAttachmentBytes() throws {
        let blob = try Envelope.decodeBlob(Data(contentsOf: vectors().appendingPathComponent("attachment.bin.json")))
        let bytes = try Envelope.open(blob, with: key("key.jwk"), context: Envelope.attachmentContext("msg_test1", "att1"))
        XCTAssertEqual(bytes, try Data(contentsOf: vectors().appendingPathComponent("attachment-expected.bin")))
    }

    func testWrongContextIsRefused() throws {
        struct Body: Decodable { var id: String; var envelope: Envelope.Blob }
        let body = try JSONDecoder().decode(Body.self, from: Data(contentsOf: vectors().appendingPathComponent("body.json")))
        XCTAssertThrowsError(try Envelope.open(body.envelope, with: key("key.jwk"), context: Envelope.messageBodyContext("msg_other"))) {
            XCTAssertEqual($0 as? Envelope.Failure, .wrongKey)
        }
    }

    func testWrongKeyIsRefused() throws {
        struct Body: Decodable { var id: String; var envelope: Envelope.Blob }
        let body = try JSONDecoder().decode(Body.self, from: Data(contentsOf: vectors().appendingPathComponent("body.json")))
        XCTAssertThrowsError(try Envelope.open(body.envelope, with: key("other-key.jwk"), context: Envelope.messageBodyContext(body.id))) {
            XCTAssertEqual($0 as? Envelope.Failure, .wrongKey)
        }
    }

    func testTamperedCiphertextIsRefused() throws {
        struct Body: Decodable { var id: String; var envelope: Envelope.Blob }
        var body = try JSONDecoder().decode(Body.self, from: Data(contentsOf: vectors().appendingPathComponent("body.json")))
        var ct = Data(base64Encoded: body.envelope.ct)!
        ct[3] ^= 0x01
        body.envelope.ct = ct.base64EncodedString()
        XCTAssertThrowsError(try Envelope.open(body.envelope, with: key("key.jwk"), context: Envelope.messageBodyContext(body.id)))
    }

    func testKeyFileAcceptsWhatFilesAirDropAndPasteDeliver() throws {
        let raw = try Data(contentsOf: vectors().appendingPathComponent("key.jwk"))
        let expected = try key("key.jwk").fingerprint
        XCTAssertEqual(try KeyFile.read(raw).fingerprint, expected)
        XCTAssertEqual(try KeyFile.read(Data([0xEF, 0xBB, 0xBF]) + raw).fingerprint, expected, "UTF-8 BOM from some editors")
        let object = try JSONSerialization.jsonObject(with: raw)
        let pretty = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted])
        XCTAssertEqual(try KeyFile.read(pretty + Data("\n".utf8)).fingerprint, expected, "pretty-printed with a trailing newline")
        let flattened = String(decoding: pretty, as: UTF8.self).replacingOccurrences(of: "\n", with: "")
        XCTAssertEqual(try KeyFile.parse(flattened).fingerprint, expected, "a secure field drops the newlines of a paste")
        var extra = try XCTUnwrap(object as? [String: Any])
        extra["kid"] = "envelope"
        extra["use"] = "enc"
        XCTAssertEqual(try KeyFile.read(JSONSerialization.data(withJSONObject: extra)).fingerprint, expected, "extra JWK members")
    }

    func testKeyFileRefusesTheWrongFiles() throws {
        let jwk = try key("key.jwk").jwk
        XCTAssertThrowsError(try KeyFile.parse(#"{"kty":"EC","crv":"P-256","x":"\#(jwk.x)","y":"\#(jwk.y)"}"#)) {
            XCTAssertEqual($0 as? KeyFile.Failure, .publicOnly)
        }
        XCTAssertThrowsError(try KeyFile.parse("lojo-key-v1.eyJ2IjoxfQ")) { XCTAssertEqual($0 as? KeyFile.Failure, .wrappedKey) }
        XCTAssertThrowsError(try KeyFile.read(Data(repeating: 0x20, count: KeyFile.maxBytes + 1))) { XCTAssertEqual($0 as? KeyFile.Failure, .tooLarge) }
        XCTAssertThrowsError(try KeyFile.read(Data([0xFF, 0xFE, 0x00, 0xD8]))) { XCTAssertEqual($0 as? KeyFile.Failure, .notText) }
        XCTAssertThrowsError(try KeyFile.parse(#"{"hello":"world"}"#)) { XCTAssertEqual($0 as? KeyFile.Failure, .malformed) }
        for failure in [KeyFile.Failure.tooLarge, .notText, .wrappedKey, .publicOnly, .malformed] {
            XCTAssertFalse(failure.localizedDescription.contains(jwk.d), "messages never echo key material")
        }
    }

    func testRejectsPublicOnlyOrMismatchedJWK() throws {
        let jwk = try key("key.jwk").jwk
        XCTAssertThrowsError(try Envelope.PrivateKey(pasted: #"{"kty":"EC","crv":"P-256","x":"\#(jwk.x)","y":"\#(jwk.y)"}"#))
        let other = try key("other-key.jwk").jwk
        XCTAssertThrowsError(try Envelope.PrivateKey(jwk: .init(kty: "EC", crv: "P-256", x: other.x, y: other.y, d: jwk.d)))
        XCTAssertThrowsError(try Envelope.PrivateKey(pasted: "not json"))
    }

    func testFingerprintMatchesServer() throws {
        XCTAssertEqual(try key("key.jwk").fingerprint, try String(contentsOf: vectors().appendingPathComponent("key-fingerprint.txt"), encoding: .utf8))
        XCTAssertNotEqual(try key("key.jwk").fingerprint, try key("other-key.jwk").fingerprint)
    }
}

final class ModelTests: XCTestCase {
    func testDecodesLiveShapedMessageAndGroupsThreads() throws {
        let json = """
        {"messages":[
          {"id":"m2","threadId":"t1","folder":"inbox","origin":"inbound","from":{"email":"a@example.com","name":"Ada"},"to":[{"email":"lojo@cyberphysical.us"}],"cc":[],"subject":"Re: Gate","date":"2026-09-30T03:28:15.000Z","snippet":"s","unread":true,"labels":["flagged"],"attachments":[{"id":"att1","filename":"x.jpg","contentType":"image/jpeg","size":119624}],"bulk":false,"pgpEncrypted":false,"ai":{"priority":"later","phishingScore":0,"skipped":true},"locked":true,"verdicts":{"dkim":"pass"},"newServerField":1},
          {"id":"m3","threadId":"t2","folder":"inbox","origin":"inbound","from":{"email":"b@example.com"},"to":[],"subject":"Other","date":"2026-09-30T02:00:00Z","unread":false,"labels":[],"attachments":[],"ai":null,"locked":true},
          {"id":"m1","threadId":"t1","folder":"inbox","origin":"sent","from":{"email":"lojo@cyberphysical.us"},"to":[{"email":"a@example.com","name":"Ada"}],"subject":"Gate","date":"2026-09-29T01:00:00.000Z","unread":false,"labels":[],"attachments":[],"locked":true}
        ]}
        """
        struct Page: Decodable { var messages: [Message] }
        let page = try JSONDecoder().decode(Page.self, from: Data(json.utf8))
        let conversations = Conversation.group(page.messages)
        XCTAssertEqual(conversations.map(\.id), ["t1", "t2"])
        XCTAssertEqual(conversations[0].messages.map(\.id), ["m1", "m2"])
        XCTAssertTrue(conversations[0].unread)
        XCTAssertTrue(conversations[0].starred)
        XCTAssertTrue(conversations[0].hasAttachments)
        XCTAssertEqual(conversations[0].subject, "Gate")
        XCTAssertEqual(conversations[0].participants(me: "lojo@cyberphysical.us"), "Ada")
    }

    func testDraftDecodingAndAuthorNotice() throws {
        let json = """
        {"draft":{"id":"drf_1","to":[{"email":"lojo-test@cyberphysical.us"}],"cc":[],"subject":"Hi","status":"pending_approval","origin":"rule","lastEditedBy":"agent","aiGenerated":true,"pgp":"auto","createdAt":"2026-09-30T00:00:00Z","updatedAt":"2026-09-30T00:00:00Z"},"text":"Body"}
        """
        let view = try JSONDecoder().decode(DraftView.self, from: Data(json.utf8))
        XCTAssertEqual(view.draft.status, .pendingApproval)
        XCTAssertEqual(
            view.draft.authorNotice,
            "One of your mail rules wrote this draft, and an assistant last changed it. It is waiting for your approval. Check the recipients and the text before you send."
        )
        XCTAssertEqual(DraftFields(view).to, "lojo-test@cyberphysical.us")
    }

    func testChangedFieldsMatchesWebReview() {
        let a = DraftFields(to: "A@x.com, b@x.com", cc: "", subject: "S", text: "T", pgp: .auto)
        let b = DraftFields(to: "a@x.com,b@x.com", cc: "", subject: "S", text: "T2", pgp: .off)
        XCTAssertEqual(a.changed(comparedTo: b), ["message text", "encryption"])
    }

    func testRulesDecode() throws {
        let json = """
        {"rules":{"version":1,"paused":false,"killSwitch":true,"trashRetentionDays":30,"maxAutoSendPerDay":20,"rules":[{"id":"r1","name":"Ack","enabled":true,"match":{"from":["@x.com"]},"actions":[{"type":"reply","reply":{"mode":"autoSend","template":"ok","maxChars":400,"allowSenders":["@x.com"],"allowCategories":[],"perSenderPerDay":1,"perDay":5}},{"type":"label","labels":["ack"]}],"stop":false,"createdBy":"human","updatedAt":"2026-09-30T00:00:00Z"}],"updatedAt":"2026-09-30T03:33:39.900Z","updatedBy":"human"},"autoSendEnabled":false}
        """
        let view = try JSONDecoder().decode(RulesState.self, from: Data(json.utf8))
        XCTAssertTrue(view.rules.killSwitch)
        XCTAssertNil(view.rules.sendKillSwitch)
        XCTAssertTrue(view.rules.rules[0].autoSends)
        XCTAssertEqual(view.rules.rules[0].actions.map(\.summary), ["Auto-reply (guarded)", "Label ack"])
        let newer = try JSONDecoder().decode(RulesDocument.self, from: Data(#"{"paused":false,"killSwitch":false,"sendKillSwitch":true,"rules":[]}"#.utf8))
        XCTAssertEqual(newer.sendKillSwitch, true)
    }

    func testSessionValidity() {
        let now = Date()
        let future = now.addingTimeInterval(3600).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        XCTAssertTrue(Session(sessionToken: "hs_x.y", expiresAt: future).isValid(at: now))
        XCTAssertFalse(Session(sessionToken: "nope", expiresAt: future).isValid(at: now))
        XCTAssertFalse(Session(sessionToken: "hs_x.y", expiresAt: "2020-01-01T00:00:00.000Z").isValid(at: now))
    }

    func testReplyHelpers() throws {
        XCTAssertEqual(MailText.replySubject("Hello"), "Re: Hello")
        XCTAssertEqual(MailText.replySubject("RE: Hello"), "RE: Hello")
        XCTAssertEqual(MailText.forwardSubject("Hello"), "Fwd: Hello")
        let message = try JSONDecoder().decode(Message.self, from: Data("""
        {"id":"m","threadId":"t","folder":"inbox","origin":"inbound","from":{"email":"a@x.com"},"to":[{"email":"lojo@cyberphysical.us"},{"email":"b@x.com"}],"cc":[{"email":"A@x.com"},{"email":"c@x.com"}],"subject":"S","date":"2026-09-30T00:00:00Z","unread":false,"labels":[],"attachments":[],"locked":false}
        """.utf8))
        let all = MailText.replyAll(to: message, me: "lojo@cyberphysical.us")
        XCTAssertEqual(all.to, ["a@x.com"])
        XCTAssertEqual(all.cc, ["b@x.com", "c@x.com"])
    }

    func testHtmlFallback() {
        let html = "<html><head><style>p{}</style></head><body><p>Hi&nbsp;Jon</p><script>alert(1)</script><ul><li>One</li></ul><img src=\"https://t.example/p.gif\"></body></html>"
        XCTAssertEqual(MailText.plainText(fromHTML: html), "Hi Jon\n• One")
    }

    func testBaseURLValidation() {
        XCTAssertNotNil(APIClient.validatedBaseURL("https://zp7h9ytl28.execute-api.us-east-1.amazonaws.com/"))
        XCTAssertNotNil(APIClient.validatedBaseURL("http://127.0.0.1:8787"))
        XCTAssertNil(APIClient.validatedBaseURL("http://example.com"))
        XCTAssertNil(APIClient.validatedBaseURL("ftp://x"))
    }

    func testRequestPaths() throws {
        let client = APIClient(baseURL: URL(string: "https://api.example.com/")!, token: "hs_t")
        let request = try client.request("GET", "/v1/folders/inbox/messages", query: [URLQueryItem(name: "limit", value: "5")])
        XCTAssertEqual(request.url?.absoluteString, "https://api.example.com/v1/folders/inbox/messages?limit=5")
        XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer hs_t")
        let login = try client.request("POST", "/v1/session/login", json: ["passphrase": "x"], authorized: false)
        XCTAssertNil(login.value(forHTTPHeaderField: "authorization"))
    }
}
