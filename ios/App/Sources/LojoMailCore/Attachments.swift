import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// A file Jon is attaching in Compose. Held in memory only; it never touches the phone's disk.
public struct OutgoingAttachment: Sendable, Hashable, Identifiable {
    public let id: UUID
    public var filename: String
    public var contentType: String
    public let data: Data
    public let sha256: String

    public init(filename: String, contentType: String, data: Data, id: UUID = UUID()) {
        self.id = id
        self.filename = OutgoingAttachment.cleanFilename(filename)
        self.contentType = contentType.isEmpty ? "application/octet-stream" : contentType
        self.data = data
        self.sha256 = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public var size: Int { data.count }

    /// Keeps the name a recipient sees readable and safe as a MIME filename: no paths, no control characters.
    public static func cleanFilename(_ name: String) -> String {
        let last = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        let cleaned = String(last.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && $0 != "\"" })
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, cleaned != ".", cleaned != ".." else { return "attachment" }
        return cleaned.count > 120 ? String(cleaned.prefix(120)) : cleaned
    }
}

/// How much fits in one message. The server's limit is on the whole encoded message, so attachments are counted as
/// base64 with line breaks, plus headers: the same arithmetic as `estimatedMessageBytes` in
/// `packages/core/src/draft-attachments.ts`, so a file the app says fits is one the server accepts.
public struct AttachmentBudget: Sendable, Hashable {
    public static let defaultMaxMessageBytes = 4_000_000
    public static let defaultMaxFiles = 10

    public var maxMessageBytes: Int
    public var maxFiles: Int

    public init(maxMessageBytes: Int = AttachmentBudget.defaultMaxMessageBytes, maxFiles: Int = AttachmentBudget.defaultMaxFiles) {
        self.maxMessageBytes = maxMessageBytes
        self.maxFiles = maxFiles
    }

    public init(_ support: DraftAttachmentSupport?) {
        self.init(maxMessageBytes: support?.maxMessageBytes ?? AttachmentBudget.defaultMaxMessageBytes,
                  maxFiles: support?.maxFiles ?? AttachmentBudget.defaultMaxFiles)
    }

    static let messageOverhead = 2_048
    static let perAttachmentOverhead = 512

    /// Base64 in 76-character lines with CRLF.
    public static func encodedSize(_ bytes: Int) -> Int {
        let base64 = (bytes + 2) / 3 * 4
        return base64 + (base64 + 75) / 76 * 2
    }

    /// Text goes out as quoted-printable; counting it at 1.1× covers typical accents and long lines.
    public func estimatedMessageBytes(textBytes: Int, attachmentSizes: [Int]) -> Int {
        AttachmentBudget.messageOverhead + textBytes + textBytes / 10
            + attachmentSizes.reduce(0) { $0 + AttachmentBudget.encodedSize($1) + AttachmentBudget.perAttachmentOverhead }
    }

    public func fits(textBytes: Int, attachmentSizes: [Int]) -> Bool {
        attachmentSizes.count <= maxFiles && estimatedMessageBytes(textBytes: textBytes, attachmentSizes: attachmentSizes) <= maxMessageBytes
    }

    /// Largest raw file that still fits next to what is already attached.
    public func remainingRawBytes(textBytes: Int, attachmentSizes: [Int]) -> Int {
        let left = maxMessageBytes - estimatedMessageBytes(textBytes: textBytes, attachmentSizes: attachmentSizes) - AttachmentBudget.perAttachmentOverhead
        guard left > 0 else { return 0 }
        return max(0, left * 76 / 78 * 3 / 4 - 3)
    }

    /// Share of the message limit in use, for the meter in Compose.
    public func usage(textBytes: Int, attachmentSizes: [Int]) -> Double {
        Double(estimatedMessageBytes(textBytes: textBytes, attachmentSizes: attachmentSizes)) / Double(maxMessageBytes)
    }
}

public enum ByteSize {
    /// "840 KB", "2.4 MB": decimal units, like Files and Mail.
    public static func format(_ bytes: Int) -> String {
        if bytes < 1_000 { return "\(bytes) bytes" }
        if bytes < 1_000_000 { return "\(Int((Double(bytes) / 1_000).rounded())) KB" }
        let mb = Double(bytes) / 1_000_000
        return mb < 10 ? String(format: "%.1f MB", mb) : "\(Int(mb.rounded())) MB"
    }
}

extension DraftFields {
    /// The files the approval names: those already on the draft, then the ones about to be uploaded, in upload order.
    /// The server appends uploads, so this is its order once they land; any other order is a 409.
    public static func reviewedAttachments(onDraft: [DraftAttachment], pending: [OutgoingAttachment]) -> [String] {
        onDraft.map(\.sha256) + pending.map(\.sha256)
    }
}
