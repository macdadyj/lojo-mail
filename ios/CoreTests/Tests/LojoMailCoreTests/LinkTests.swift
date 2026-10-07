import Foundation
import XCTest
@testable import LojoMailCore

/// Mirrors `packages/web/src/links.test.ts`: the phone and the web app must agree on which links open and what they point at.
final class LinkTests: XCTestCase {
    private func message(from email: String = "testflight@email.apple.com", dmarc: String? = "pass", spam: String? = "PASS", labels: [String] = []) -> Message {
        Message(
            id: "msg_1", threadId: "thr_1", folder: "inbox", origin: "received", from: Address(name: "TestFlight", email: email), to: [],
            subject: "You're invited to test Harbor", date: "2026-10-03T15:00:00.000Z", unread: true, labels: labels,
            verdicts: Verdicts(spam: spam, virus: "PASS", spf: "pass", dkim: "pass", dmarc: dmarc), locked: false, attachments: []
        )
    }

    private let invite = """
    <html><body>
    <p>You're invited to test Harbor.</p>
    <p><a href="https://email.apple.com/click?link=https%3A%2F%2Ftestflight.apple.com%2Fjoin%2FAbCdEf12">View in TestFlight</a></p>
    <p>The invite expires in 30 days.</p>
    <img src="https://tracker.example/pixel.gif" alt="tracking pixel">
    <script>alert("nope")</script>
    </body></html>
    """

    private func links(_ parts: [MessagePart]) -> [MessageLink] {
        parts.compactMap { if case .link(let link) = $0 { link } else { nil } }
    }

    private func visible(_ parts: [MessagePart]) -> String {
        parts.map { part in
            switch part {
            case .text(let text): text
            case .link(let link): link.text
            }
        }.joined(separator: " ")
    }

    func testTrustedSenderOpensDirectly() {
        let list = MessageLinks.defaultTrustedDomains
        XCTAssertTrue(MessageLinks.linksOpenDirectly(message(), trusted: list))
        XCTAssertTrue(MessageLinks.linksOpenDirectly(message(from: "notifications@github.com"), trusted: list))
        XCTAssertTrue(MessageLinks.linksOpenDirectly(message(from: "ci@mail.github.com"), trusted: list))
    }

    func testFailedOrUnlistedSenderStaysBehindConfirm() {
        let list = MessageLinks.defaultTrustedDomains
        XCTAssertFalse(MessageLinks.senderVerified(message(dmarc: "fail")))
        XCTAssertFalse(MessageLinks.senderVerified(message(dmarc: nil)))
        XCTAssertFalse(MessageLinks.senderVerified(message(spam: "FAIL")))
        XCTAssertFalse(MessageLinks.senderVerified(message(labels: ["unverified-self"])))
        XCTAssertFalse(MessageLinks.senderVerified(message(labels: ["quarantined"])))
        XCTAssertFalse(MessageLinks.linksOpenDirectly(message(from: "ada@example.com"), trusted: list))
        XCTAssertFalse(MessageLinks.linksOpenDirectly(message(), trusted: []))
        XCTAssertFalse(MessageLinks.domainTrusted("notgithub.com", in: ["github.com"]))
        XCTAssertFalse(MessageLinks.domainTrusted("github.com.evil.com", in: ["github.com"]))
    }

    func testTrustedListParsing() {
        let parsed = MessageLinks.parseTrustedDomainList(" Example.COM \n# note\nnews.example.com\n")
        XCTAssertNil(parsed.error)
        XCTAssertEqual(parsed.domains, ["example.com", "news.example.com"])
        XCTAssertNotNil(MessageLinks.parseTrustedDomainList("https://apple.com").error)
        XCTAssertNotNil(MessageLinks.parseTrustedDomainList("apple.com/path").error)
        XCTAssertTrue(MessageLinks.linksOpenDirectly(message(from: "ada@news.example.com"), trusted: ["example.com"]))
    }

    func testAppleInviteKeepsTheButtonAndUnwrapsTheTrackingHop() throws {
        let parts = MessageLinks.messageParts(text: nil, html: invite)
        let link = try XCTUnwrap(links(parts).first)
        XCTAssertEqual(link.text, "View in TestFlight")
        XCTAssertTrue(link.button)
        XCTAssertEqual(link.domain, "testflight.apple.com")
        XCTAssertEqual(link.href, "https://testflight.apple.com/join/AbCdEf12")
        let text = visible(parts)
        XCTAssertTrue(text.contains("You're invited to test Harbor"))
        XCTAssertFalse(text.contains("tracker.example"))
        XCTAssertFalse(text.contains("alert"))
        XCTAssertFalse(text.contains("pixel.gif"))
    }

    func testTrackingRedirectsUnwrapOnlyWhenTheNextHopIsInsideTheURL() {
        XCTAssertEqual(
            MessageLinks.prepareLink("https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fgithub.com%2Forg%2Frepo&data=abc")?.href,
            "https://github.com/org/repo")
        XCTAssertEqual(MessageLinks.prepareLink("https://www.google.com/url?q=https%3A%2F%2Fgithub.com%2Forg&sa=D")?.domain, "github.com")
        XCTAssertEqual(
            MessageLinks.prepareLink("https://urldefense.proofpoint.com/v2/url?u=https-3A__example.com_path_file&d=Dw&e=")?.href,
            "https://example.com/path/file")
        XCTAssertEqual(
            MessageLinks.prepareLink("https://abc.r.us-east-1.awstrack.me/L0/https:%2F%2Fexample.com%2Fjoin/1/0100")?.href,
            "https://example.com/join")
        XCTAssertEqual(MessageLinks.prepareLink("https://bit.ly/not-unwrappable")?.domain, "bit.ly")
        XCTAssertEqual(MessageLinks.prepareLink("https://email.apple.com/click/opaque-token")?.domain, "email.apple.com")
        XCTAssertEqual(MessageLinks.prepareLink("https://t.co/abc")?.domain, "t.co")
    }

    func testUnsafeTargetsAreNotLinks() throws {
        let html = [
            "<a href=\"javascript:alert(1)\">click</a>",
            "<a href=\"https://user:pass@example.com/secret\">creds</a>",
            "<a href=\"https://169.254.169.254/latest\">meta</a>",
            "<a href=\"http://127.0.0.1/admin\">local</a>",
            "<img src=\"https://images.example/a.png\">",
            "<a href=\"https://example.com/ok\"><img src=\"https://images.example/button.png\" alt=\"Open notes\"></a>",
        ].joined()
        let parts = MessageLinks.messageParts(text: nil, html: html)
        let all = links(parts)
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all.first?.text, "Open notes")
        XCTAssertEqual(all.first?.href, "https://example.com/ok")
        let text = parts.map { part -> String in
            switch part {
            case .text(let text): text
            case .link(let link): "\(link.text) \(link.href)"
            }
        }.joined(separator: "\n")
        for banned in ["javascript", "user:pass", "169.254", "127.0.0.1", "images.example"] {
            XCTAssertFalse(text.contains(banned), banned)
        }
    }

    func testPlainTextKeepsBareURLsAndTrailingPunctuation() throws {
        let parts = MessageLinks.messageParts(text: "Notes at https://example.com/docs.", html: nil)
        let link = try XCTUnwrap(links(parts).first)
        XCTAssertEqual(link.href, "https://example.com/docs")
        XCTAssertFalse(link.button)
        XCTAssertTrue(visible(parts).hasSuffix("."))
    }

    func testEntitiesAndLongHTMLFallBackToText() {
        let parts = MessageLinks.messageParts(text: nil, html: "<p>Fish &amp; chips &#169; &#x41;</p>")
        XCTAssertEqual(visible(parts), "Fish & chips © A")
        let huge = "<p>" + String(repeating: "x", count: 200_001) + "</p>"
        XCTAssertEqual(visible(MessageLinks.messageParts(text: "plain fallback", html: huge)), "plain fallback")
    }
}
