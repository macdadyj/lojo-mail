import Foundation
import LojoMailCore
import Security

/// Secrets live in the iOS Keychain. The envelope key uses AfterFirstUnlock so an app update can
/// still open it. It is not written to the app sandbox. A failed read is `unavailable`, not "missing",
/// so a locked phone does not look like the key was deleted.
enum Keychain {
    private static let service = "com.lojo.Mail"

    private static func query(_ item: StoredSecret) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: item.rawValue,
        ]
    }

    private static func accessibility(_ item: StoredSecret) -> CFString {
        switch item.accessibility {
        case .afterFirstUnlock:
            return kSecAttrAccessibleAfterFirstUnlock
        case .afterFirstUnlockThisDeviceOnly:
            return kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        case .whenUnlockedThisDeviceOnly:
            return kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
    }

    /// Rewrites an existing item in place, including its accessibility. Adds only when the item is
    /// absent. Any other failure leaves the stored item alone.
    @discardableResult
    static func set(_ data: Data, for item: StoredSecret) -> Bool {
        let base = query(item)
        let update: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: accessibility(item),
        ]
        let updated = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if updated == errSecSuccess { return true }
        if updated != errSecItemNotFound { return false }
        var attributes = base
        attributes[kSecValueData] = data
        attributes[kSecAttrAccessible] = accessibility(item)
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    static func lookup(_ item: StoredSecret) -> SecretLookup {
        var request = query(item)
        request[kSecReturnData] = true
        request[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { return .missing }
            return .found(data)
        case errSecItemNotFound:
            return .missing
        case errSecInteractionNotAllowed, errSecAuthFailed:
            return .unavailable
        default:
            return .unavailable
        }
    }

    static func delete(_ item: StoredSecret) {
        SecItemDelete(query(item) as CFDictionary)
    }
}
