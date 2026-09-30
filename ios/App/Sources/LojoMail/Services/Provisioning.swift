import Foundation
import LojoMailCore

/// USB provisioning from Santa Computa (`ios/scripts/provision-phone.sh`): the script pushes files into this
/// app's container with house_arrest, which only a trusted, paired host can do for a development-signed app.
/// On launch they are moved into the Keychain and deleted. Nothing here is reachable from the Files app.
enum Provisioning {
    struct Imported {
        var session: Session?
        var key: Envelope.PrivateKey?
        var apiURL: URL?
    }

    static let files = ["provision-session.json", "provision-envelope.private.jwk", "provision-api-url.txt"]

    static func importPending() -> Imported {
        var out = Imported()
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return out }
        defer { for name in files { try? FileManager.default.removeItem(at: dir.appendingPathComponent(name)) } }
        if let data = try? Data(contentsOf: dir.appendingPathComponent("provision-session.json")),
           let session = try? JSONDecoder().decode(Session.self, from: data), session.isValid() {
            out.session = session
        }
        if let text = try? String(contentsOf: dir.appendingPathComponent("provision-envelope.private.jwk"), encoding: .utf8),
           let key = try? Envelope.PrivateKey(pasted: text) {
            out.key = key
        }
        if let text = try? String(contentsOf: dir.appendingPathComponent("provision-api-url.txt"), encoding: .utf8) {
            out.apiURL = APIClient.validatedBaseURL(text)
        }
        return out
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
    var previewSignedOut: Bool

    static let current: LaunchOptions = {
        let env = ProcessInfo.processInfo.environment
        return LaunchOptions(
            screen: env["LOJO_SCREEN"].flatMap(Screen.init(rawValue:)),
            folder: env["LOJO_FOLDER"].flatMap(Folder.init(rawValue:)),
            thread: env["LOJO_THREAD"],
            draft: env["LOJO_DRAFT"],
            search: env["LOJO_SEARCH"],
            composeTo: env["LOJO_COMPOSE_TO"],
            previewSignedOut: env["LOJO_SCREEN"] == "signin"
        )
    }()
}
