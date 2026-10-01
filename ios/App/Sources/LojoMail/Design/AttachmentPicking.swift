import LojoMailCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Turns what the pickers hand back into in-memory attachments sized for one message.
enum AttachmentImport {
    struct Failure: LocalizedError {
        var errorDescription: String?
    }

    static func mimeType(forFilename name: String) -> String {
        let ext = (name as NSString).pathExtension
        return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
    }

    /// Photos arrive as HEIC or full-size JPEG. Recipients can't all open HEIC, and a full-size photo rarely fits in
    /// 4 MB once encoded, so photos go out as JPEG, shrunk step by step until they fit in `room` bytes.
    static func photo(_ data: Data, name: String, room: Int) throws -> OutgoingAttachment {
        guard let image = UIImage(data: data) else { throw Failure(errorDescription: "That photo couldn't be read.") }
        return try photo(image, name: name, room: room)
    }

    static func photo(_ image: UIImage, name: String, room: Int) throws -> OutgoingAttachment {
        let longest = max(image.size.width * image.scale, image.size.height * image.scale)
        for edge in [longest] + [3_024.0, 2_048, 1_600, 1_200, 800].filter({ $0 < longest }) {
            let scaled = edge < longest ? resized(image, longestEdge: edge) : image
            for quality in [0.8, 0.6] {
                if let jpeg = scaled.jpegData(compressionQuality: quality), jpeg.count <= room {
                    return OutgoingAttachment(filename: name, contentType: "image/jpeg", data: jpeg)
                }
            }
        }
        throw Failure(errorDescription: room > 0
            ? "That photo doesn't fit: only \(ByteSize.format(room)) is left in this message."
            : "This message is at its size limit. Remove an attachment first.")
    }

    private static func resized(_ image: UIImage, longestEdge: Double) -> UIImage {
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let ratio = longestEdge / max(pixels.width, pixels.height)
        let size = CGSize(width: (pixels.width * ratio).rounded(), height: (pixels.height * ratio).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    /// A file from the Files picker. Size is checked before reading so a huge video is refused without loading it.
    static func file(at url: URL, room: Int) throws -> OutgoingAttachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > room {
            throw Failure(errorDescription: "\(name) is \(ByteSize.format(size)). "
                + (room > 0 ? "Only \(ByteSize.format(room)) more fits in one message." : "This message is at its size limit.")
                + " Share a link for larger files.")
        }
        let data = try Data(contentsOf: url)
        let type = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType)?.preferredMIMEType ?? mimeType(forFilename: name)
        return OutgoingAttachment(filename: name, contentType: type, data: data)
    }

    static func photoName(_ index: Int) -> String {
        let stamp = Date.now.formatted(.iso8601.year().month().day())
        return "Photo \(stamp) \(index).jpg"
    }

    static func systemImage(forContentType type: String) -> String {
        if type.hasPrefix("image/") { return "photo" }
        if type.hasPrefix("video/") { return "film" }
        if type.hasPrefix("audio/") { return "waveform" }
        if type == "application/pdf" { return "doc.richtext" }
        if type.contains("zip") || type.contains("compressed") { return "doc.zipper" }
        if type.hasPrefix("text/") { return "doc.text" }
        if type.contains("spreadsheet") || type.contains("excel") || type == "text/csv" { return "tablecells" }
        if type.contains("pgp") || type.contains("pkcs") || type.contains("x509") { return "key" }
        return "doc"
    }
}

/// The system camera. Only offered when the device has one (not on most iPads in Split View, never on Linux CI).
struct CameraPicker: UIViewControllerRepresentable {
    var onPhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    static var available: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onPhoto(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// The share sheet for a decrypted file. The caller deletes the temporary file when this closes.
struct ActivitySheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
