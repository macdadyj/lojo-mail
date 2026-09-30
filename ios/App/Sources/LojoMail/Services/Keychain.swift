import Foundation
import Security

/// Secrets live only in the iOS Keychain, device-only (never in iCloud Keychain or an unencrypted backup).
enum Keychain {
    enum Item: String, CaseIterable {
        case session
        case passphrase
        case envelopeKey

        /// Background refresh runs while the phone is locked, so the session and the optional stored passphrase
        /// are readable after first unlock. The envelope key is only needed on screen, so it is readable only while unlocked.
        var accessibility: CFString {
            switch self {
            case .session, .passphrase: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            case .envelopeKey: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            }
        }
    }

    private static let service = "com.lojo.Mail"

    private static func query(_ item: Item) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: item.rawValue,
        ]
    }

    @discardableResult
    static func set(_ data: Data, for item: Item) -> Bool {
        SecItemDelete(query(item) as CFDictionary)
        var attributes = query(item)
        attributes[kSecValueData] = data
        attributes[kSecAttrAccessible] = item.accessibility
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    static func get(_ item: Item) -> Data? {
        var request = query(item)
        request[kSecReturnData] = true
        request[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    static func delete(_ item: Item) {
        SecItemDelete(query(item) as CFDictionary)
    }

    static func deleteAll() {
        for item in Item.allCases { delete(item) }
    }
}
