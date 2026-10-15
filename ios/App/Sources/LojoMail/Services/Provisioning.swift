import Foundation
import LojoMailCore

/// USB provisioning from Santa Computa (`ios/scripts/provision-phone.sh`): the script pushes files into this
/// app's container with house_arrest, which only a trusted, paired host can do for a development-signed app.
/// Launch and the "USB from Santa Computa" button move them into the Keychain and delete the files.
/// Nothing here is reachable from the Files app.
enum Provisioning {
    static let files = USBProvision.fileNames

    /// Files handed to the app ("Open in LOJO Mail", AirDrop) are copied into Documents/Inbox. Only key files arrive
    /// there, so nothing in it is kept.
    static func purgeInbox() {
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("Inbox", isDirectory: true))
    }

    /// Deletes `url` only if it lives inside this app's container (an Inbox copy), never a file Jon picked in Files.
    static func removeIfOwned(_ url: URL) {
        let home = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.resolvingSymlinksInPath().path
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        guard path.hasPrefix(home + "/Documents/Inbox/") || path.hasPrefix(home + "/tmp/") else { return }
        try? FileManager.default.removeItem(at: url)
    }

    static func importPending() -> USBProvision.Files {
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return USBProvision.Files()
        }
        return USBProvision.consume(directory: dir)
    }
}

/// QA hooks for on-device screenshots, set with `pymobiledevice3 ... launch-application --env KEY=VALUE`
/// (see `ios/scripts/phone-shot.sh`). They only choose what is on screen; none of them can send or change mail
/// (`sendconfirm` shows the confirmation, which still needs a tap).
struct LaunchOptions {
    enum Screen: String {
        case inbox, thread, attachment, compose, sendconfirm, review, draft, rules, settings, search, signin, key, folder
    }

    var screen: Screen?
    var folder: Folder?
    var thread: String?
    var draft: String?
    var search: String?
    var composeTo: String?
    /// Opens Compose with two generated sample files, so the attachments UI can be checked and photographed.
    var composeSamples: Bool
    var previewSignedOut: Bool
    /// Simulator UI tests. Loads an in-memory mailbox. Never writes the Keychain or turns on test mode.
    var uiTest: Bool

    static let current: LaunchOptions = {
        let env = ProcessInfo.processInfo.environment
        let args = ProcessInfo.processInfo.arguments
        let uiTest = args.contains("-LojoMailUITest") || env["LOJO_UITEST"] == "1"
        let screenName = env["LOJO_SCREEN"]
            ?? args.drop(while: { $0 != "-LojoMailUITestScreen" }).dropFirst().first
        return LaunchOptions(
            screen: screenName.flatMap(Screen.init(rawValue:)),
            folder: env["LOJO_FOLDER"].flatMap(Folder.init(rawValue:)),
            thread: env["LOJO_THREAD"],
            draft: env["LOJO_DRAFT"],
            search: env["LOJO_SEARCH"],
            composeTo: env["LOJO_COMPOSE_TO"],
            composeSamples: env["LOJO_COMPOSE_SAMPLES"] == "1",
            previewSignedOut: screenName == "signin",
            uiTest: uiTest
        )
    }()
}
