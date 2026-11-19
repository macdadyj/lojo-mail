import XCTest
@testable import LojoMailCore

final class ForwardTests: XCTestCase {
    func testSubjectPrefixesOnce() {
        XCTAssertEqual(MailText.forwardSubject("Hello"), "Fwd: Hello")
        XCTAssertEqual(MailText.forwardSubject("  Hello  "), "Fwd: Hello")
        XCTAssertEqual(MailText.forwardSubject("Fwd: Hello"), "Fwd: Hello")
        XCTAssertEqual(MailText.forwardSubject("FWD: Hello"), "FWD: Hello")
        XCTAssertEqual(MailText.forwardSubject("fwd:Hello"), "fwd:Hello")
        XCTAssertEqual(MailText.forwardSubject("  Fwd: Hello  "), "Fwd: Hello")
        XCTAssertEqual(MailText.forwardSubject("Fw: Hello"), "Fw: Hello")
        XCTAssertEqual(MailText.forwardSubject("FW: Hello"), "FW: Hello")
        XCTAssertEqual(MailText.forwardSubject("Re: Hello"), "Fwd: Re: Hello")
        XCTAssertEqual(MailText.forwardSubject("Fwd: Re: Hello"), "Fwd: Re: Hello")
        XCTAssertEqual(MailText.forwardSubject(""), "Fwd: ")
    }

    func testQuotePutsTheNoteAboveTheHeaderAndKeepsCc() throws {
        let message = try sample(cc: true, files: [])
        let noted = MailText.forwardBody(note: " Please see this. ", original: "The gate is open.", message: message)
        XCTAssertTrue(noted.hasPrefix("Please see this.\n\n\(MailText.forwardSeparator)\n"))
        let header = try XCTUnwrap(noted.range(of: MailText.forwardSeparator))
        let body = try XCTUnwrap(noted.range(of: "The gate is open."))
        XCTAssertLessThan(header.lowerBound, body.lowerBound)
        XCTAssertTrue(noted.hasSuffix("The gate is open."))
        XCTAssertFalse(noted.contains("> The gate is open."))

        let lines = noted.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let from = try XCTUnwrap(lines.firstIndex { $0.hasPrefix("From: ") })
        XCTAssertEqual(lines[from], "From: Ada <ada@example.com>")
        XCTAssertEqual(lines[from + 1].hasPrefix("Date: "), true)
        XCTAssertGreaterThan(lines[from + 1].count, "Date: ".count)
        XCTAssertEqual(lines[from + 2], "Subject: Gate sensor")
        XCTAssertEqual(lines[from + 3], "To: lojo@cyberphysical.us, Bea <bea@example.com>")
        XCTAssertEqual(lines[from + 4], "Cc: Ada <ada@example.com>, copy@example.com")
        XCTAssertEqual(lines[from + 5], "")
        XCTAssertEqual(lines[from + 6], "The gate is open.")
    }

    func testQuoteOmitsAnEmptyCcLine() throws {
        let message = try sample(cc: false, files: [])
        let quoted = MailText.forwarded("Body line", message: message)
        XCTAssertTrue(quoted.hasPrefix("\n\n\(MailText.forwardSeparator)\n"))
        let lines = quoted.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        XCTAssertFalse(lines.contains { $0.hasPrefix("Cc:") })
        XCTAssertTrue(lines.contains("To: lojo@cyberphysical.us, Bea <bea@example.com>"))
        XCTAssertTrue(quoted.hasSuffix("Body line"))
    }

    func testRecipientsStartEmptyAndOriginalFilesCanBeDropped() throws {
        let message = try sample(cc: true, files: [
            #"{"id":"att_photo","filename":"gate.jpg","contentType":"image/jpeg","size":24000}"#,
            #"{"id":"att_notes","filename":"notes.pdf","contentType":"application/pdf","size":1200}"#,
        ])
        var composed = ForwardCompose(message: message, body: "The gate is open.", note: "Passing this along.")
        XCTAssertEqual(composed.to, "")
        XCTAssertEqual(composed.cc, "")
        XCTAssertEqual(composed.bcc, "")
        XCTAssertEqual(composed.subject, "Fwd: Gate sensor")
        XCTAssertTrue(composed.text.hasPrefix("Passing this along.\n\n\(MailText.forwardSeparator)"))
        XCTAssertEqual(composed.attachments.map(\.filename), ["gate.jpg", "notes.pdf"])

        composed.removeAttachment(id: "att_photo")
        XCTAssertEqual(composed.attachments.map(\.id), ["att_notes"])
        composed.removeAttachment(id: "missing")
        XCTAssertEqual(composed.attachments.map(\.filename), ["notes.pdf"])

        let bare = ForwardCompose(message: try sample(cc: false, files: []), body: "Nothing attached.")
        XCTAssertTrue(bare.attachments.isEmpty)
        XCTAssertEqual(bare.to, "")
        XCTAssertEqual(bare.cc, "")
        XCTAssertEqual(bare.bcc, "")
    }

    func testBccRidesTheExistingDraftPayload() throws {
        let empty = DraftFields(to: "a@x.com", subject: "Fwd: S", text: "See below.")
        XCTAssertEqual(empty.bccList, [])
        XCTAssertEqual(empty.payload["bcc"] as? [String], [])
        XCTAssertEqual(empty.allRecipients, ["a@x.com"])

        let json = """
        {"draft":{"id":"drf_fwd","to":[{"email":"new@example.com"}],"cc":[{"email":"copy@example.com"}],"bcc":[{"email":"Hidden@example.com"}],"subject":"Fwd: S","status":"edited","origin":"human","pgp":"auto","createdAt":"2026-10-15T00:00:00Z","updatedAt":"2026-10-15T00:00:00Z"},"text":"See below."}
        """
        let fields = DraftFields(try JSONDecoder().decode(DraftView.self, from: Data(json.utf8)))
        XCTAssertEqual(fields.bccList, ["Hidden@example.com"])
        XCTAssertEqual(fields.payload["bcc"] as? [String], ["Hidden@example.com"])
        XCTAssertEqual(fields.approvalPayload["bcc"] as? [String], ["Hidden@example.com"])
        XCTAssertEqual(fields.allRecipients, ["new@example.com", "copy@example.com", "Hidden@example.com"])
        XCTAssertEqual(
            fields.changed(comparedTo: DraftFields(to: "new@example.com", cc: "copy@example.com", subject: "Fwd: S", text: "See below.")),
            ["recipients (Bcc)"]
        )
    }

    private func sample(cc: Bool, files: [String]) throws -> Message {
        let copied = cc ? #","cc":[{"email":"ada@example.com","name":"Ada"},{"email":"copy@example.com"}]"# : ""
        let attachments = files.joined(separator: ",")
        let json = """
        {"id":"m","threadId":"t","folder":"inbox","origin":"inbound","from":{"email":"ada@example.com","name":"Ada"},"to":[{"email":"lojo@cyberphysical.us"},{"email":"bea@example.com","name":"Bea"}]\(copied),"subject":"Gate sensor","date":"2026-10-15T14:05:00.000Z","unread":false,"labels":[],"attachments":[\(attachments)],"locked":false}
        """
        return try JSONDecoder().decode(Message.self, from: Data(json.utf8))
    }
}
