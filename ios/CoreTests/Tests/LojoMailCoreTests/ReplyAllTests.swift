import XCTest
@testable import LojoMailCore

final class ReplyAllTests: XCTestCase {
    func testReplyAllPutsSenderAndToOnTheToLineAndCcOnCc() throws {
        let message = try message("""
        {"id":"m","threadId":"t","folder":"inbox","origin":"inbound","from":{"email":"Ada@Example.com","name":"Ada"},"to":[{"email":"lojo@cyberphysical.us"},{"email":"bea@example.com"},{"email":"ada@example.com"}],"cc":[{"email":"copy@example.com"},{"email":"Bea@Example.com"},{"email":"jon@example.com"}],"subject":"Re: Gate","rfcMessageId":"<gate-2@example.com>","references":["<gate-1@example.com>","<gate-2@example.com>"],"date":"2026-10-15T00:00:00Z","unread":true,"labels":[],"attachments":[],"locked":false}
        """)
        let all = MailText.replyAll(to: message, me: ["lojo@cyberphysical.us", "Jon@Example.com"])
        XCTAssertEqual(all.to, ["Ada@Example.com", "bea@example.com"])
        XCTAssertEqual(all.cc, ["copy@example.com"])
        XCTAssertEqual(MailText.replySubject(message.subject), "Re: Gate")
        XCTAssertEqual(MailText.replySubject("Re: Gate"), "Re: Gate")
        XCTAssertEqual(MailText.replyReferences(of: message), ["<gate-1@example.com>", "<gate-2@example.com>"])
        let quoted = MailText.quoted("The north gate is back.", from: message.from, date: nil)
        XCTAssertTrue(quoted.contains("Ada <Ada@Example.com> wrote:"))
        XCTAssertTrue(quoted.contains("> The north gate is back."))
    }

    func testReplyAllOnSentMailSkipsTheSenderAndKeepsTheOriginalLists() throws {
        let message = try message("""
        {"id":"m","threadId":"t","folder":"sent","origin":"sent","from":{"email":"lojo@cyberphysical.us"},"to":[{"email":"ada@example.com"},{"email":"lojo@cyberphysical.us"}],"cc":[{"email":"copy@example.com"}],"subject":"Hello","date":"2026-10-15T00:00:00Z","unread":false,"labels":[],"attachments":[],"locked":false}
        """)
        let all = MailText.replyAll(to: message, me: "lojo@cyberphysical.us")
        XCTAssertEqual(all.to, ["ada@example.com"])
        XCTAssertEqual(all.cc, ["copy@example.com"])
        XCTAssertEqual(MailText.replyReferences(of: message), [])
    }

    private func message(_ json: String) throws -> Message {
        try JSONDecoder().decode(Message.self, from: Data(json.utf8))
    }
}
