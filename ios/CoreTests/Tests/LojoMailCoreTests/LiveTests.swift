import Foundation
import XCTest
@testable import LojoMailCore

/// Read-only checks against the deployed API. Skipped unless `LOJO_LIVE_SESSION_FILE` (a file holding a
/// `hs_` session token) and `LOJO_LIVE_KEY_FILE` (the envelope private JWK) are set; `scripts/test-core.sh --live` sets them
/// from `~/.config/lojo-mail`. Nothing here writes, moves or sends. Note: reading a thread marks it read on the server.
final class LiveTests: XCTestCase {
    private func live() throws -> (APIClient, Envelope.PrivateKey) {
        let env = ProcessInfo.processInfo.environment
        guard let sessionFile = env["LOJO_LIVE_SESSION_FILE"], let keyFile = env["LOJO_LIVE_KEY_FILE"] else {
            throw XCTSkip("live API test not requested")
        }
        let token = try String(contentsOfFile: sessionFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let key = try Envelope.PrivateKey(pasted: String(contentsOfFile: keyFile, encoding: .utf8))
        let base = env["LOJO_LIVE_API"].flatMap(URL.init(string:)) ?? APIClient.defaultBaseURL
        return (APIClient(baseURL: base, token: token), key)
    }

    func testDecryptsEveryInboxBodyAndAttachment() async throws {
        let (api, key) = try live()
        let settings = try await api.settings()
        XCTAssertEqual(settings.principal, "human")
        if let published = settings.envelopeKeyFingerprint {
            XCTAssertEqual(key.fingerprint, published, "the local key is the one this mailbox seals to")
        }
        let messages = try await api.folder(.inbox, limit: 50)
        XCTAssertFalse(messages.isEmpty)
        var attachments = 0
        for message in messages where message.locked {
            let blob = try await api.body(message.id)
            _ = try Envelope.openJSON(SealedBody.self, blob, with: key, context: Envelope.messageBodyContext(message.id))
            for attachment in message.attachments {
                let payload = try await api.attachment(messageId: message.id, attachmentId: attachment.id)
                let bytes: Data
                switch payload {
                case .plain(let data): bytes = data
                case .sealed(let blob):
                    bytes = try Envelope.open(blob, with: key, context: Envelope.attachmentContext(message.id, attachment.id))
                case .sealedAt(let url):
                    bytes = try Envelope.open(try Envelope.decodeBlob(try await api.download(url)), with: key, context: Envelope.attachmentContext(message.id, attachment.id))
                }
                XCTAssertEqual(bytes.count, attachment.size, attachment.filename)
                attachments += 1
            }
        }
        print("live: opened \(messages.count) bodies and \(attachments) attachments")
    }

    func testDraftsRulesAndSearchDecode() async throws {
        let (api, _) = try live()
        _ = try await api.drafts()
        let rules = try await api.rules()
        print("live: rules=\(rules.rules.rules.count) killSwitch=\(rules.rules.killSwitch) sendKillSwitch=\(rules.rules.sendKillSwitch.map(String.init) ?? "absent") autoSendEnabled=\(rules.autoSendEnabled)")
        _ = try await api.search("test")
        for folder in Folder.allCases { _ = try await api.folder(folder, limit: 5) }
    }
}
