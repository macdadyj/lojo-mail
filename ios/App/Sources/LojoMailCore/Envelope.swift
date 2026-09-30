import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Opens the per-message envelopes the processor seals (`packages/core/src/crypto/envelope.ts`):
/// ephemeral P-256 ECDH, HKDF-SHA256 (empty salt, info `lojo-mail-envelope-v1`), AES-256-GCM with the
/// message (or attachment) context as additional data. WebCrypto appends the 16-byte GCM tag to `ct`.
public enum Envelope {
    public static let algorithm = "P-256-ECDH+HKDF-SHA256+AES-256-GCM"
    static let info = Data("lojo-mail-envelope-v1".utf8)

    public struct PublicJWK: Codable, Sendable, Hashable {
        public var kty: String
        public var crv: String
        public var x: String
        public var y: String
    }

    public struct Blob: Codable, Sendable, Hashable {
        public var v: Int
        public var alg: String
        public var epk: PublicJWK
        public var iv: String
        public var ct: String
    }

    public enum Failure: Error, LocalizedError, Equatable {
        case unsupported(String)
        case malformedKey
        case wrongKey
        case malformed(String)

        public var errorDescription: String? {
            switch self {
            case .unsupported(let what): "This message uses an envelope format the app does not know (\(what))."
            case .malformedKey: "That is not an envelope private key. Paste the P-256 JWK that includes \"d\"."
            case .wrongKey: "The envelope key on this iPhone cannot open this message. It may be sealed to a different key."
            case .malformed(let what): "The sealed message is damaged (\(what))."
            }
        }
    }

    public static func messageBodyContext(_ messageId: String) -> String {
        "lojo-mail:message:\(messageId):body"
    }

    public static func attachmentContext(_ messageId: String, _ attachmentId: String) -> String {
        "lojo-mail:message:\(messageId):attachment:\(attachmentId)"
    }

    public static func open(_ blob: Blob, with key: PrivateKey, context: String) throws -> Data {
        guard blob.v == 2, blob.alg == algorithm else { throw Failure.unsupported("v\(blob.v) \(blob.alg)") }
        guard !context.isEmpty else { throw Failure.malformed("no context") }
        guard let x = Base64URL.decode(blob.epk.x), let y = Base64URL.decode(blob.epk.y), x.count == 32, y.count == 32 else {
            throw Failure.malformed("ephemeral key")
        }
        let ephemeral: P256.KeyAgreement.PublicKey
        do {
            ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: Data([0x04]) + x + y)
        } catch {
            throw Failure.malformed("ephemeral key")
        }
        guard let iv = Data(base64Encoded: blob.iv), iv.count == 12, let sealed = Data(base64Encoded: blob.ct), sealed.count >= 16 else {
            throw Failure.malformed("ciphertext")
        }
        let shared = try key.key.sharedSecretFromKeyAgreement(with: ephemeral)
        let aes = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: info, outputByteCount: 32)
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: iv),
                ciphertext: sealed.prefix(sealed.count - 16),
                tag: sealed.suffix(16)
            )
            return try AES.GCM.open(box, using: aes, authenticating: Data(context.utf8))
        } catch {
            throw Failure.wrongKey
        }
    }

    public static func openJSON<T: Decodable>(_ type: T.Type, _ blob: Blob, with key: PrivateKey, context: String) throws -> T {
        let plain = try open(blob, with: key, context: context)
        do {
            return try JSONDecoder().decode(T.self, from: plain)
        } catch {
            throw Failure.malformed("contents")
        }
    }

    /// Attachments over the inline limit come from a presigned S3 URL as the JSON-encoded envelope bytes.
    public static func decodeBlob(_ data: Data) throws -> Blob {
        do {
            return try JSONDecoder().decode(Blob.self, from: data)
        } catch {
            throw Failure.malformed("envelope")
        }
    }

    /// The envelope private key (`keys/envelope.private.jwk`). Only `d`, `x` and `y` are kept.
    public struct PrivateKey: Sendable {
        let key: P256.KeyAgreement.PrivateKey
        public let jwk: JWK

        public struct JWK: Codable, Sendable, Hashable {
            public var kty: String
            public var crv: String
            public var x: String
            public var y: String
            public var d: String
        }

        public init(jwk: JWK) throws {
            guard jwk.kty == "EC", jwk.crv == "P-256", let d = Base64URL.decode(jwk.d), d.count == 32,
                  let x = Base64URL.decode(jwk.x), let y = Base64URL.decode(jwk.y) else {
                throw Failure.malformedKey
            }
            let key: P256.KeyAgreement.PrivateKey
            do {
                key = try P256.KeyAgreement.PrivateKey(rawRepresentation: d)
            } catch {
                throw Failure.malformedKey
            }
            guard key.publicKey.x963Representation == Data([0x04]) + x + y else { throw Failure.malformedKey }
            self.key = key
            self.jwk = JWK(kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d)
        }

        /// Accepts the pasted file contents, with or without surrounding whitespace or extra JWK members.
        public init(pasted text: String) throws {
            guard let data = text.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
                  let jwk = try? JSONDecoder().decode(JWK.self, from: data) else {
                throw Failure.malformedKey
            }
            try self.init(jwk: jwk)
        }

        public func encoded() throws -> Data {
            try JSONEncoder().encode(jwk)
        }

        /// Same as `keyFingerprint` in `packages/core/src/crypto/envelope.ts`, which `/v1/settings` publishes as
        /// `envelopeKeyFingerprint`: SHA-256 of `P-256:<x>:<y>`, first 10 bytes, hex in groups of four.
        public var fingerprint: String {
            let digest = SHA256.hash(data: Data("P-256:\(jwk.x):\(jwk.y)".utf8))
            let hex = digest.prefix(10).map { String(format: "%02x", $0) }.joined()
            return stride(from: 0, to: hex.count, by: 4).map { offset in
                let start = hex.index(hex.startIndex, offsetBy: offset)
                return String(hex[start..<hex.index(start, offsetBy: 4)])
            }.joined(separator: "-")
        }
    }
}

public enum Base64URL {
    public static func decode(_ value: String) -> Data? {
        var base = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base = base.trimmingCharacters(in: CharacterSet(charactersIn: "="))
        while base.count % 4 != 0 { base += "=" }
        return Data(base64Encoded: base)
    }
}
