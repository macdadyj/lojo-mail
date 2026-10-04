import Foundation
import LojoMailCore

/// Last folder listings, so the app opens instantly and works offline. Metadata only (the same fields the
/// server keeps in the clear in DynamoDB); decrypted bodies are never written to disk. Files are protected
/// until first unlock and excluded from backups.
enum MetadataCache {
    private static var directory: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("metadata-cache", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var url = dir
            try? url.setResourceValues(values)
        }
        return dir
    }

    struct Snapshot: Codable {
        var savedAt: Date
        var messages: [Message]
    }

    static func save(_ messages: [Message], for folder: Folder) {
        guard let dir = directory else { return }
        let stripped = messages.map { message -> Message in
            var copy = message
            copy.text = nil
            copy.summary = nil
            return copy
        }
        guard let data = try? JSONEncoder().encode(Snapshot(savedAt: Date(), messages: stripped)) else { return }
        try? data.write(to: dir.appendingPathComponent("\(folder.rawValue).json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func load(_ folder: Folder) -> Snapshot? {
        guard let dir = directory, let data = try? Data(contentsOf: dir.appendingPathComponent("\(folder.rawValue).json")) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    static func clear() {
        guard let dir = directory else { return }
        try? FileManager.default.removeItem(at: dir)
    }
}

/// Decrypted attachments are written only to a per-launch temporary folder for Quick Look and removed after.
enum AttachmentFiles {
    static var directory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("attachments", isDirectory: true)
    }

    static func write(_ data: Data, filename: String) throws -> URL {
        let folder = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safe = filename.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let url = folder.appendingPathComponent(safe.isEmpty ? "attachment" : safe)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    static func remove(_ url: URL) {
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }

    static func purge() {
        try? FileManager.default.removeItem(at: directory)
    }
}
