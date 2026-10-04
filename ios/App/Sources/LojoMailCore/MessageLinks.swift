import Foundation

/// Port of `packages/web/src/links.ts`: the same trusted-sender rule and the same tracking-link unwrapping, so a message
/// behaves the same on the phone and in the web app. Nothing here loads anything. A tracking redirect is removed only
/// when the next hop is written inside the URL itself.
public struct MessageLink: Sendable, Hashable {
    public var text: String
    public var href: String
    public var domain: String
    /// Short link text with no URL in it: the web app draws these as a button.
    public var button: Bool
}

public enum MessagePart: Sendable, Hashable {
    case text(String)
    case link(MessageLink)
}

public enum MessageLinks {
    public static let defaultTrustedDomains = ["apple.com", "email.apple.com", "testflight.apple.com", "github.com"]

    private static let maxHTMLChars = 200_000
    private static let trackerParams = ["url", "q", "u", "link", "destination", "redirect", "dest", "target"]
    private static let skipTags: Set<String> = ["script", "style", "noscript", "head", "svg", "iframe", "object", "template", "title"]
    private static let blockTags: Set<String> = ["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table", "section", "article"]
    private static let domainPattern = "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$"

    // MARK: Trust

    public static func normalizeDomain(_ value: String) -> String? {
        var domain = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while domain.hasSuffix(".") { domain.removeLast() }
        return domain.range(of: domainPattern, options: .regularExpression) != nil ? domain : nil
    }

    /// One domain per line, `#` comments allowed. Returns nil for the error text when a line is not a domain name.
    public static func parseTrustedDomainList(_ text: String) -> (domains: [String], error: String?) {
        var domains: [String] = []
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            guard let domain = normalizeDomain(trimmed) else { return (domains, "\"\(trimmed)\" is not a domain name") }
            if !domains.contains(domain) { domains.append(domain) }
        }
        return (domains, nil)
    }

    public static func emailDomain(_ email: String) -> String? {
        guard let at = email.lastIndex(of: "@") else { return nil }
        return normalizeDomain(String(email[email.index(after: at)...]))
    }

    /// A listed domain matches itself and its subdomains, and nothing that merely ends with the same letters.
    public static func domainTrusted(_ domain: String, in list: [String]) -> Bool {
        let host = domain.lowercased()
        return list.contains { host == $0 || host.hasSuffix(".\($0)") }
    }

    /// SES recorded DMARC pass, the message was not a spam or virus fail, and it is not quarantined or an unverified-self.
    public static func senderVerified(_ message: Message) -> Bool {
        guard message.verdicts?.dmarc == "pass" else { return false }
        if message.verdicts?.spam == "FAIL" || message.verdicts?.virus == "FAIL" { return false }
        return !message.labels.contains("quarantined") && !message.labels.contains("unverified-self")
    }

    public static func linksOpenDirectly(_ message: Message, trusted: [String]) -> Bool {
        guard senderVerified(message), let domain = emailDomain(message.from.email) else { return false }
        return domainTrusted(domain, in: trusted)
    }

    // MARK: URLs

    public static func prepareLink(_ raw: String) -> (href: String, domain: String)? {
        guard let url = unwrapTrackingURL(raw), let host = url.host?.lowercased() else { return nil }
        return (url.absoluteString, host)
    }

    public static func unwrapTrackingURL(_ raw: String) -> URL? {
        guard var current = publicHTTPURL(raw) else { return nil }
        for _ in 0..<3 {
            guard trackerHost(current) else { return current }
            guard let nextRaw = nestedDestination(current), let next = publicHTTPURL(nextRaw), next.absoluteString != current.absoluteString else { return current }
            current = next
        }
        return current
    }

    private static func publicHTTPURL(_ raw: String) -> URL? {
        let cleaned = String(String.UnicodeScalarView(raw.unicodeScalars.filter { $0.value > 0x1f && $0.value != 0x7f }))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, let components = URLComponents(string: cleaned), let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http", components.user == nil, components.password == nil,
              let host = components.host, isPublicHost(host), let url = components.url else { return nil }
        return url
    }

    private static func isPublicHost(_ hostname: String) -> Bool {
        var host = hostname.lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty || host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") { return false }
        if host.contains(":") || host.hasPrefix("[") { return false }
        if host.range(of: "^\\d{1,3}(\\.\\d{1,3}){3}$", options: .regularExpression) != nil { return false }
        return host.contains(".")
    }

    private static func trackerHost(_ url: URL) -> Bool {
        let host = (url.host ?? "").lowercased()
        if (host == "google.com" || host == "www.google.com") && url.path == "/url" { return true }
        if host == "href.li" { return true }
        if host == "safelinks.protection.outlook.com" || host.hasSuffix(".safelinks.protection.outlook.com") { return true }
        if host == "l.facebook.com" || host == "lm.facebook.com" || host == "l.instagram.com" { return true }
        if isProofpoint(host) { return true }
        if host.hasSuffix(".awstrack.me") { return true }
        if host == "email.apple.com" || host.hasSuffix(".email.apple.com") { return true }
        if host == "clicks.apple.com" || host.hasSuffix(".clicks.apple.com") { return true }
        return false
    }

    private static func isProofpoint(_ host: String) -> Bool {
        host == "urldefense.com" || host == "urldefense.proofpoint.com" || host.hasSuffix(".urldefense.proofpoint.com")
    }

    private static func nestedDestination(_ url: URL) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let host = (components.host ?? "").lowercased()
        if host.hasSuffix(".awstrack.me") {
            let parts = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            if let index = parts.firstIndex(of: "L0"), index + 1 < parts.count, let decoded = decodeURLValue(parts[index + 1]) { return decoded }
        }
        if host == "href.li" {
            let first = (components.percentEncodedQuery ?? "").split(separator: "&", omittingEmptySubsequences: false).first.map(String.init) ?? ""
            if let decoded = decodeURLValue(first) { return decoded }
        }
        let items = components.queryItems ?? []
        for name in trackerParams {
            if let value = items.first(where: { $0.name == name })?.value, !value.isEmpty, let decoded = decodeURLValue(value) { return decoded }
        }
        if isProofpoint(host) {
            for name in trackerParams {
                guard let value = items.first(where: { $0.name == name })?.value, !value.isEmpty else { continue }
                let swapped = value.replacingOccurrences(of: "-", with: "%").replacingOccurrences(of: "_", with: "/")
                if let decoded = swapped.removingPercentEncoding, isHTTPPrefix(decoded) { return decoded }
            }
        }
        return nil
    }

    private static func isHTTPPrefix(_ value: String) -> Bool {
        value.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func decodeURLValue(_ value: String) -> String? {
        var current = value.trimmingCharacters(in: .whitespacesAndNewlines)
        for _ in 0..<2 {
            if isHTTPPrefix(current) { return current }
            guard let next = current.removingPercentEncoding, next != current else { break }
            current = next
        }
        return isHTTPPrefix(current) ? current : nil
    }

    // MARK: Parts

    /// HTML is preferred when present (that is where an invitation's button lives); plain text otherwise.
    public static func messageParts(text: String?, html: String?) -> [MessagePart] {
        let html = html ?? ""
        if !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, html.count <= maxHTMLChars {
            let parts = tidy(htmlParts(html))
            if !parts.isEmpty { return parts }
        }
        return tidy(textParts(text ?? ""))
    }

    private static func decodeEntities(_ value: String) -> String {
        guard value.contains("&"), let regex = try? NSRegularExpression(pattern: "&(#x?[0-9a-fA-F]+|[a-zA-Z]+);") else { return value }
        let ns = value as NSString
        var out = ""
        var last = 0
        for match in regex.matches(in: value, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            let entity = ns.substring(with: match.range)
            let body = ns.substring(with: match.range(at: 1)).lowercased()
            switch body {
            case "amp": out += "&"
            case "lt": out += "<"
            case "gt": out += ">"
            case "quot": out += "\""
            case "apos", "#39": out += "'"
            case "nbsp": out += " "
            default: out += numericEntity(body) ?? entity
            }
            last = match.range.location + match.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    private static func numericEntity(_ body: String) -> String? {
        guard body.hasPrefix("#") else { return nil }
        let hex = body.hasPrefix("#x")
        guard let code = UInt32(body.dropFirst(hex ? 2 : 1), radix: hex ? 16 : 10), code > 0, code <= 0x10ffff,
              !(0xd800...0xdfff).contains(code), let scalar = Unicode.Scalar(code) else { return nil }
        return String(Character(scalar))
    }

    private struct Tag {
        var end: Int
        var name: String
        var close: Bool
        var attrs: [String: String]
    }

    private static func isLetter(_ c: Character) -> Bool { c.isASCII && c.isLetter }
    private static func isNameChar(_ c: Character) -> Bool { c.isASCII && (c.isLetter || c.isNumber) }
    private static func isAttrStart(_ c: Character) -> Bool { c.isASCII && (c.isLetter || c == "_" || c == ":") }
    private static func isAttrChar(_ c: Character) -> Bool { c.isASCII && (c.isLetter || c.isNumber || "-_:.".contains(c)) }

    private static func scanTag(_ s: [Character], _ start: Int) -> Tag? {
        guard start < s.count, s[start] == "<" else { return nil }
        var i = start + 1
        var close = false
        if i < s.count, s[i] == "/" { close = true; i += 1 }
        guard i < s.count, isLetter(s[i]) else { return nil }
        var name = ""
        while i < s.count, isNameChar(s[i]) { name.append(s[i]); i += 1 }
        name = name.lowercased()
        var attrs: [String: String] = [:]
        while i < s.count, s[i] != ">" {
            while i < s.count, s[i].isWhitespace { i += 1 }
            if i >= s.count || s[i] == ">" || s[i] == "/" { break }
            guard isAttrStart(s[i]) else { i += 1; continue }
            var attr = ""
            while i < s.count, isAttrChar(s[i]) { attr.append(s[i]); i += 1 }
            while i < s.count, s[i].isWhitespace { i += 1 }
            var value = ""
            if i < s.count, s[i] == "=" {
                i += 1
                while i < s.count, s[i].isWhitespace { i += 1 }
                if i < s.count, s[i] == "\"" || s[i] == "'" {
                    let quote = s[i]
                    i += 1
                    guard let end = s[i...].firstIndex(of: quote) else { return nil }
                    value = String(s[i..<end])
                    i = end + 1
                } else {
                    while i < s.count, !s[i].isWhitespace, s[i] != ">" { value.append(s[i]); i += 1 }
                }
            }
            attrs[attr.lowercased()] = decodeEntities(value)
        }
        guard let end = s[min(i, s.count)...].firstIndex(of: ">") else { return nil }
        return Tag(end: end + 1, name: name, close: close, attrs: attrs)
    }

    private static func find(_ needle: String, in s: [Character], from: Int) -> Int? {
        let n = Array(needle)
        guard !n.isEmpty, s.count >= n.count, from <= s.count - n.count else { return nil }
        for i in from...(s.count - n.count) where s[i] == n[0] && Array(s[i..<(i + n.count)]) == n { return i }
        return nil
    }

    private static func starts(_ s: [Character], _ i: Int, _ prefix: String) -> Bool {
        let p = Array(prefix)
        return i + p.count <= s.count && Array(s[i..<(i + p.count)]) == p
    }

    /// Index just past `</name\s*>`, case-insensitive.
    private static func closer(of name: String, in s: [Character], from: Int) -> Int? {
        let n = Array(name)
        var i = from
        while i < s.count {
            guard let open = find("</", in: s, from: i) else { return nil }
            var j = open + 2
            var k = 0
            while k < n.count, j < s.count, Character(s[j].lowercased()) == n[k] { j += 1; k += 1 }
            if k == n.count {
                while j < s.count, s[j].isWhitespace { j += 1 }
                if j < s.count, s[j] == ">" { return j + 1 }
            }
            i = open + 2
        }
        return nil
    }

    private static func htmlParts(_ rawHTML: String) -> [MessagePart] {
        let s = Array(rawHTML.replacingOccurrences(of: "\r\n", with: "\n"))
        var parts: [MessagePart] = []
        var text = ""
        var linkText = ""
        var linkHref: String?
        func write(_ chunk: String) {
            if linkHref != nil { linkText += chunk } else { text += chunk }
        }
        var i = 0
        while i < s.count {
            if starts(s, i, "<!--") {
                i = find("-->", in: s, from: i + 4).map { $0 + 3 } ?? s.count
                continue
            }
            if s[i] != "<" {
                let next = s[i...].firstIndex(of: "<") ?? s.count
                write(decodeEntities(String(s[i..<next])))
                i = next
                continue
            }
            guard let tag = scanTag(s, i) else { write("<"); i += 1; continue }
            if !tag.close, skipTags.contains(tag.name) {
                i = closer(of: tag.name, in: s, from: tag.end) ?? s.count
                continue
            }
            if tag.name == "br" {
                write("\n")
            } else if tag.name == "img", linkHref != nil {
                write(tag.attrs["alt"] ?? "")
            } else if tag.close, blockTags.contains(tag.name), linkHref == nil {
                if !text.isEmpty, !text.hasSuffix("\n") { text += "\n" }
            } else if tag.name == "a", !tag.close {
                if !text.isEmpty { parts.append(.text(text)); text = "" }
                linkHref = tag.attrs["href"] ?? ""
                linkText = ""
            } else if tag.name == "a", tag.close, let href = linkHref {
                pushLink(&parts, href: href, label: linkText)
                linkHref = nil
                linkText = ""
            }
            i = tag.end
        }
        if !text.isEmpty { parts.append(.text(text)) }
        return parts
    }

    private static func pushLink(_ parts: inout [MessagePart], href: String, label source: String) {
        let label = source.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        guard let prepared = prepareLink(href) else {
            if !label.isEmpty { parts.append(.text(label)) }
            return
        }
        let text = label.isEmpty ? prepared.domain : label
        parts.append(.link(MessageLink(text: text, href: prepared.href, domain: prepared.domain, button: text.count <= 40 && !isURLText(text))))
    }

    private static func isURLText(_ value: String) -> Bool {
        value.range(of: "https?://", options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func textParts(_ text: String) -> [MessagePart] {
        guard let regex = try? NSRegularExpression(pattern: "https?://[^\\s<>\"']+", options: .caseInsensitive) else { return [.text(text)] }
        let ns = text as NSString
        var parts: [MessagePart] = []
        var last = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if match.range.location > last { parts.append(.text(ns.substring(with: NSRange(location: last, length: match.range.location - last)))) }
            var raw = ns.substring(with: match.range)
            var trail = ""
            while let end = raw.last, "),.;:!?]}".contains(end) {
                trail = String(end) + trail
                raw.removeLast()
            }
            if let prepared = prepareLink(raw) {
                parts.append(.link(MessageLink(text: raw, href: prepared.href, domain: prepared.domain, button: false)))
            } else {
                parts.append(.text(raw))
            }
            if !trail.isEmpty { parts.append(.text(trail)) }
            last = match.range.location + match.range.length
        }
        if last < ns.length { parts.append(.text(ns.substring(from: last))) }
        return parts
    }

    private static func tidy(_ parts: [MessagePart]) -> [MessagePart] {
        var merged: [MessagePart] = []
        for part in parts {
            switch part {
            case .link(let link):
                if !link.text.isEmpty { merged.append(part) }
            case .text(let raw):
                let text = raw
                    .replacingOccurrences(of: "[ \\t]+\\n", with: "\n", options: .regularExpression)
                    .replacingOccurrences(of: "[ \\t]{2,}", with: " ", options: .regularExpression)
                    .replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
                if text.isEmpty { continue }
                if case .text(let previous)? = merged.last { merged[merged.count - 1] = .text(previous + text) } else { merged.append(.text(text)) }
            }
        }
        if case .text(let first)? = merged.first { merged[0] = .text(first.replacingOccurrences(of: "^\\n+", with: "", options: .regularExpression)) }
        if case .text(let last)? = merged.last { merged[merged.count - 1] = .text(last.replacingOccurrences(of: "\\n+$", with: "", options: .regularExpression)) }
        return merged.filter { if case .text(let t) = $0 { return !t.isEmpty } else { return true } }
    }
}
