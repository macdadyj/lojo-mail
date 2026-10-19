import Foundation
import XCTest

final class PrivacyManifestTests: XCTestCase {
    func testPrivacyManifestCoversMailAndDoesNotTrack() throws {
        let plist = try load("App/Resources/PrivacyInfo.xcprivacy")
        XCTAssertEqual(plist["NSPrivacyTracking"] as? Bool, false)
        let domains = plist["NSPrivacyTrackingDomains"] as? [String]
        XCTAssertEqual(domains, [])
        let accessed = plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]] ?? []
        let categories = accessed.compactMap { $0["NSPrivacyAccessedAPIType"] as? String }
        XCTAssertTrue(categories.contains("NSPrivacyAccessedAPICategoryUserDefaults"))
        let collected = plist["NSPrivacyCollectedDataTypes"] as? [[String: Any]] ?? []
        let types = Set(collected.compactMap { $0["NSPrivacyCollectedDataType"] as? String })
        XCTAssertTrue(types.contains("NSPrivacyCollectedDataTypeEmailAddress"))
        XCTAssertTrue(types.contains("NSPrivacyCollectedDataTypeName"))
        XCTAssertTrue(types.contains("NSPrivacyCollectedDataTypeOtherUserContent"))
        for row in collected {
            XCTAssertEqual(row["NSPrivacyCollectedDataTypeTracking"] as? Bool, false)
            XCTAssertEqual(row["NSPrivacyCollectedDataTypeLinked"] as? Bool, true)
            XCTAssertEqual(row["NSPrivacyCollectedDataTypePurposes"] as? [String], ["NSPrivacyCollectedDataTypePurposeAppFunctionality"])
        }
        let text = try String(contentsOf: source("App/Resources/PrivacyInfo.xcprivacy"), encoding: .utf8)
        XCTAssertFalse(text.contains("BEGIN "))
        XCTAssertFalse(text.localizedCaseInsensitiveContains("api_key"))
    }

    func testLaunchScreenUsesTheBrandColorAndDeclaresNoExtraEncryption() throws {
        let info = try load("App/Info-xcode.plist")
        let launch = info["UILaunchScreen"] as? [String: Any]
        XCTAssertEqual(launch?["UIColorName"] as? String, "LaunchBackground")
        XCTAssertEqual(info["ITSAppUsesNonExemptEncryption"] as? Bool, false)
        let color = try String(contentsOf: source("App/Resources/Assets.xcassets/LaunchBackground.colorset/Contents.json"), encoding: .utf8)
        XCTAssertTrue(color.contains("\"alpha\" : \"1.000\""))
    }

    private func load(_ relative: String) throws -> [String: Any] {
        let data = try Data(contentsOf: source(relative))
        let decoded = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(decoded as? [String: Any])
    }

    private func source(_ relative: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(relative)
    }
}
