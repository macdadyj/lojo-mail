import Foundation
import XCTest

final class AppStoreMetadataTests: XCTestCase {
    func testListingCopyStaysPublicAndNamesTheRealActions() throws {
        let description = try text("description.txt")
        XCTAssertTrue(description.contains("LOJO Mail"))
        XCTAssertTrue(description.contains("Filter with SI"))
        XCTAssertTrue(description.contains("Reply with SI"))
        XCTAssertTrue(description.contains("Approve and send"))
        XCTAssertFalse(description.localizedCaseInsensitiveContains("test mode"))
        XCTAssertFalse(description.contains("BEGIN "))
        XCTAssertNil(description.range(of: #"\b\d{1,3}(?:\.\d{1,3}){3}\b"#, options: .regularExpression))
        XCTAssertNil(description.range(of: #"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#, options: [.regularExpression, .caseInsensitive]))

        let keywords = try text("keywords.txt").trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertLessThanOrEqual(keywords.count, 100)
        XCTAssertFalse(keywords.contains(" "))
        XCTAssertTrue(keywords.contains("SI"))
        XCTAssertFalse(keywords.localizedCaseInsensitiveContains("test mode"))

        XCTAssertEqual(try text("support_url.txt").trimmingCharacters(in: .whitespacesAndNewlines), "https://example.com/support")
    }

    func testScreenshotSlotsMatchTheAppStoreSizes() throws {
        let names = [
            "01-sign-in.png",
            "02-inbox.png",
            "03-thread.png",
            "04-filter-with-si.png",
            "05-compose.png",
            "06-approval-queue.png",
            "07-settings.png",
            "08-envelope-key.png",
        ]
        for name in names {
            let phone = try pngSize("screenshots/6.1-inch/\(name)")
            XCTAssertEqual(phone.width, 1170, name)
            XCTAssertEqual(phone.height, 2532, name)
            let large = try pngSize("screenshots/6.7-inch/\(name)")
            XCTAssertEqual(large.width, 1290, name)
            XCTAssertEqual(large.height, 2796, name)
        }
    }

    private func text(_ name: String) throws -> String {
        try String(contentsOf: root().appendingPathComponent(name), encoding: .utf8)
    }

    private func pngSize(_ relative: String) throws -> (width: Int, height: Int) {
        let data = try Data(contentsOf: root().appendingPathComponent(relative))
        XCTAssertGreaterThanOrEqual(data.count, 24)
        let header = Data([0x89, 0x50, 0x4E, 0x47])
        XCTAssertEqual(data.prefix(4), header)
        let width = Int(data[16]) << 24 | Int(data[17]) << 16 | Int(data[18]) << 8 | Int(data[19])
        let height = Int(data[20]) << 24 | Int(data[21]) << 16 | Int(data[22]) << 8 | Int(data[23])
        return (width, height)
    }

    private func root() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("AppStore")
    }
}
