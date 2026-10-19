import XCTest
@testable import LojoMailCore

final class MailSearchTests: XCTestCase {
    func testEveryWordMustMatchAndLabelsCount() {
        let query = MailSearchQuery("  Gate church ")
        XCTAssertEqual(query.terms, ["gate", "church"])
        XCTAssertTrue(MailSearch.matches(
            subject: "Gate code",
            senderName: "Ada",
            senderEmail: "ada@example.com",
            snippet: "Tuesday",
            labels: ["Church"],
            query: query
        ))
        XCTAssertFalse(MailSearch.matches(
            subject: "Gate code",
            senderName: "Ada",
            senderEmail: "ada@example.com",
            snippet: nil,
            labels: [],
            query: query
        ))
        XCTAssertTrue(MailSearchQuery("   ").isEmpty)
        XCTAssertTrue(MailSearch.matches(subject: "Anything", senderName: "", senderEmail: "", snippet: nil, labels: [], query: MailSearchQuery("  ")))
    }

    func testRecentSearchesStayShortAndDoNotTouchTestMode() {
        var recent: [String] = []
        recent = MailSearch.remember("Gate", recent: recent)
        recent = MailSearch.remember("gate", recent: recent)
        recent = MailSearch.remember("  ", recent: recent)
        recent = MailSearch.remember("Invoice", recent: recent)
        XCTAssertEqual(recent, ["Invoice", "gate"])
        let long = (1...10).reduce(recent) { MailSearch.remember("q\($1)", recent: $0) }
        XCTAssertEqual(long.count, MailSearch.recentLimit)
        XCTAssertNotEqual(MailSearch.recentDefaultsKey, "sendTestMode")
        XCTAssertFalse(MailSearch.recentDefaultsKey.localizedCaseInsensitiveContains("key"))
        XCTAssertEqual(MailSearch.resultsTitle(count: 1), "1 result in all mail · subject, sender, snippet, and labels")
        XCTAssertTrue(MailSearch.allMailSuggestion("Gate").contains("Gate"))
    }
}
