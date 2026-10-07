import Foundation

/// Reads `envelope.private.jwk` however it reached the phone: Files, AirDrop, "Open in LOJO Mail", or the clipboard.
public enum KeyFile {
    /// A JWK is about 250 bytes; anything this big is the wrong file.
    public static let maxBytes = 64 * 1024

    public enum Failure: LocalizedError, Equatable {
        case tooLarge
        case notText
        case wrappedKey
        case publicOnly
        case malformed

        public var errorDescription: String? {
            switch self {
            case .tooLarge: "That file is too big to be an envelope key. Pick envelope.private.jwk."
            case .notText: "That file isn't text. Pick envelope.private.jwk."
            case .wrappedKey: "That is the passphrase-wrapped key from the web app (lojo-key-v1…). The iPhone needs envelope.private.jwk itself."
            case .publicOnly: "That is the public key. Pick envelope.private.jwk, the file with a \"d\" member."
            case .malformed: "That isn't a P-256 private key in JWK form. Pick envelope.private.jwk."
            }
        }
    }

    public static func read(_ data: Data) throws -> Envelope.PrivateKey {
        guard data.count <= maxBytes else { throw Failure.tooLarge }
        var bytes = data
        if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
        guard let text = String(data: bytes, encoding: .utf8) else { throw Failure.notText }
        return try parse(text)
    }

    public static func parse(_ text: String) throws -> Envelope.PrivateKey {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("lojo-key-v1.") { throw Failure.wrappedKey }
        if let object = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)) as? [String: Any],
           object["x"] != nil, object["d"] == nil {
            throw Failure.publicOnly
        }
        do {
            return try Envelope.PrivateKey(pasted: trimmed)
        } catch {
            throw Failure.malformed
        }
    }
}
