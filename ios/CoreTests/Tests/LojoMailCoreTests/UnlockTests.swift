import Foundation
import XCTest
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import LojoMailCore

final class UnlockAndPersistenceTests: XCTestCase {
    func testEveryUnlockOptionIsAButton() {
        let actions = Set(UnlockScreen.buttons.map(\.action))
        XCTAssertEqual(actions, Set(UnlockButton.Action.allCases))
        for button in UnlockScreen.buttons {
            XCTAssertFalse(button.title.isEmpty)
            XCTAssertTrue(button.accessibilityIdentifier.hasPrefix("unlock."))
            XCTAssertFalse(UnlockScreen.detail(for: button.action).isEmpty)
            XCTAssertFalse(UnlockScreen.missingGuidance(for: button.action).isEmpty)
        }
        XCTAssertEqual(
            UnlockScreen.loadButtons.first { $0.action == .usbFromSantaComputa }?.title,
            "USB from Santa Computa"
        )
        XCTAssertEqual(UnlockScreen.retry.accessibilityIdentifier, "unlock.retry")
        XCTAssertEqual(UnlockScreen.saveButton.accessibilityIdentifier, "unlock.save")
    }

    func testUSBImportUnlocksAndDeletesTheSandboxCopy() throws {
        let dir = try tempDir()
        let jwk = try jwkText()
        try jwk.write(to: dir.appendingPathComponent(USBProvision.keyFileName), atomically: true, encoding: .utf8)
        let session = #"{"sessionToken":"hs_example","expiresAt":"2099-01-01T00:00:00Z"}"#
        try session.write(to: dir.appendingPathComponent(USBProvision.sessionFileName), atomically: true, encoding: .utf8)
        let files = USBProvision.consume(directory: dir)
        XCTAssertEqual(USBProvision.outcome(files), .unlocked)
        XCTAssertEqual(files.session?.sessionToken, "hs_example")
        XCTAssertNotNil(files.key)
        for name in USBProvision.fileNames {
            XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path))
        }
    }

    func testUSBImportMissingOffersGuidance() throws {
        let dir = try tempDir()
        let files = USBProvision.consume(directory: dir)
        guard case .missing(let guidance) = USBProvision.outcome(files) else {
            return XCTFail("expected missing, got \(USBProvision.outcome(files))")
        }
        XCTAssertTrue(guidance.contains("provision-phone.sh"))
        XCTAssertTrue(guidance.contains("Try again"))
    }

    func testUSBImportRejectsABadFileWithoutLeavingIt() throws {
        let dir = try tempDir()
        try "not a key".write(to: dir.appendingPathComponent(USBProvision.keyFileName), atomically: true, encoding: .utf8)
        let files = USBProvision.consume(directory: dir)
        guard case .failed = USBProvision.outcome(files) else {
            return XCTFail("expected failed")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent(USBProvision.keyFileName).path))
    }

    func testEnvelopeKeySurvivesSessionExpiryAppUpdateAndRelaunch() throws {
        let key = try jwkData()
        XCTAssertEqual(StoredSecret.envelopeKey.accessibility, .afterFirstUnlock)
        XCTAssertNotEqual(StoredSecret.envelopeKey.accessibility, .whenUnlockedThisDeviceOnly)
        var life = KeySurvival.install(key: key, session: Data("hs_example".utf8))
        life = life.expireSession()
        XCTAssertEqual(life.store.get(.session), .missing)
        XCTAssertEqual(life.store.get(.envelopeKey), .found(key))
        for step in [SessionStep.ready, .renew, .reauthenticate] {
            XCTAssertFalse(SessionRecovery.removesEnvelopeKey(on: step))
        }
        XCTAssertEqual(
            SessionRecovery.step(sessionValid: false, passphrase: .absent),
            .reauthenticate
        )
        XCTAssertEqual(
            SessionRecovery.step(sessionValid: false, passphrase: .present),
            .renew
        )
        life = life.appUpdate()
        XCTAssertTrue(life.sandbox.isEmpty)
        XCTAssertEqual(life.relaunch(screenLocked: true), .found(key))
        XCTAssertEqual(life.relaunch(screenLocked: false), .found(key))
    }

    func testLockedWhenUnlockedReadIsNotTreatedAsAMissingKey() throws {
        let key = try jwkData()
        var store = MemorySecretStore(screenLocked: true)
        store.items[StoredSecret.envelopeKey.rawValue] = .init(data: key, accessibility: .whenUnlockedThisDeviceOnly)
        XCTAssertEqual(store.get(.envelopeKey), .unavailable)
        XCTAssertEqual(EnvelopeKeyLoad.decide(read: store.get(.envelopeKey)), .unchanged)
        store.set(key, for: .envelopeKey)
        XCTAssertEqual(store.get(.envelopeKey), .found(key))
        XCTAssertEqual(EnvelopeKeyLoad.decide(read: .missing), .absent)
    }

    func testTestModeStaysOffUntilChosen() {
        XCTAssertFalse(TestModePolicy.isOn(keychain: .unset, userDefaults: .unset))
        XCTAssertFalse(TestModePolicy.isOn(keychain: .unset, userDefaults: .explicit(false)))
        XCTAssertTrue(TestModePolicy.isOn(keychain: .unset, userDefaults: .explicit(true)))
        XCTAssertFalse(TestModePolicy.isOn(keychain: .explicit(false), userDefaults: .explicit(true)))
        XCTAssertFalse(TestModePolicy.isOn(keychain: .explicit(false), userDefaults: .unset))
        XCTAssertTrue(TestModePolicy.isOn(keychain: .explicit(true), userDefaults: .unset))
        XCTAssertFalse(LaunchSideEffects.enablesTestMode(screen: "signin"))
        XCTAssertFalse(LaunchSideEffects.enablesTestMode(screen: nil))
        XCTAssertFalse(LaunchSideEffects.discardsEnvelopeKey(screen: "key"))
    }

    func testUnreadablePassphraseDoesNotSignOut() {
        XCTAssertEqual(SessionRecovery.step(sessionValid: false, passphrase: .unreadable), .renew)
        XCTAssertEqual(SessionRecovery.step(sessionValid: true, passphrase: .absent), .ready)
    }

    private func tempDir() throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("lojo-unlock-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    private func jwkText() throws -> String {
        String(decoding: try jwkData(), as: UTF8.self)
    }

    private func jwkData() throws -> Data {
        let key = P256.KeyAgreement.PrivateKey()
        let raw = key.rawRepresentation
        let x963 = key.publicKey.x963Representation
        XCTAssertEqual(x963.count, 65)
        let x = base64url(Data(x963.dropFirst(1).prefix(32)))
        let y = base64url(Data(x963.dropFirst(33)))
        let text = #"{"kty":"EC","crv":"P-256","x":"\#(x)","y":"\#(y)","d":"\#(base64url(raw))"}"#
        let parsed = try Envelope.PrivateKey(pasted: text)
        return try parsed.encoded()
    }

    private func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
