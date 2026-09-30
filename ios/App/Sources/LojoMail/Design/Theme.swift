import LojoMailCore
import SwiftUI
import UIKit

enum Theme {
    static let accent = Color(red: 0.06, green: 0.52, blue: 0.56)
    static let unread = Color(red: 0.16, green: 0.47, blue: 0.96)
    static let star = Color.orange
    static let danger = Color.red
    static let ai = Color.purple

    static func avatarColor(for email: String) -> Color {
        let palette: [Color] = [.teal, .indigo, .orange, .pink, .green, .blue, .purple, .brown, .cyan, .mint]
        let sum = email.lowercased().unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return palette[sum % palette.count]
    }
}

struct Chip: View {
    var text: String
    var systemImage: String?
    var tint: Color = .secondary

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(text)
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .foregroundStyle(tint)
        .background(tint.opacity(0.14), in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

struct Avatar: View {
    var address: Address
    var size: CGFloat = 36

    private var initials: String {
        let source = address.name?.nonEmptyTrimmed ?? address.email
        let parts = source.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "@" || $0 == "_" }).prefix(2)
        return parts.compactMap(\.first).map { String($0).uppercased() }.joined()
    }

    var body: some View {
        Text(initials.isEmpty ? "?" : initials)
            .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Theme.avatarColor(for: address.email).gradient, in: Circle())
            .accessibilityHidden(true)
    }
}

struct ToastView: View {
    var toast: Toast
    var onUndo: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: toast.systemImage)
            Text(toast.text).font(.subheadline.weight(.medium)).lineLimit(2)
            Spacer(minLength: 8)
            if toast.undo != nil {
                Button("Undo", action: onUndo).font(.subheadline.weight(.bold))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.15), radius: 10, y: 4)
        .padding(.horizontal)
        .accessibilityElement(children: .contain)
    }
}

struct StateView: View {
    var title: String
    var systemImage: String
    var message: String?
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            if let message { Text(message) }
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(.borderedProminent)
            }
        }
    }
}

struct Banner: View {
    var text: String
    var systemImage: String
    var tint: Color = .secondary

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.footnote.weight(.medium))
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityElement(children: .combine)
    }
}

enum Haptics {
    @MainActor static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    @MainActor static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    @MainActor static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}

extension String {
    var nonEmptyTrimmed: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension Date {
    /// "9:41 AM" today, "Tue" this week, "Sep 3" this year, else "9/3/25".
    var mailListStamp: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(self) { return formatted(date: .omitted, time: .shortened) }
        if calendar.isDateInYesterday(self) { return "Yesterday" }
        if let days = calendar.dateComponents([.day], from: self, to: Date()).day, days < 7 { return formatted(.dateTime.weekday(.abbreviated)) }
        if calendar.isDate(self, equalTo: Date(), toGranularity: .year) { return formatted(.dateTime.month(.abbreviated).day()) }
        return formatted(date: .numeric, time: .omitted)
    }
}

/// Plain text with links made tappable. No HTML, no remote content.
func linkified(_ text: String) -> AttributedString {
    var attributed = AttributedString(text)
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return attributed }
    let ns = text as NSString
    for match in detector.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        guard let url = match.url, let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme),
              let range = Range(match.range, in: text), let lower = AttributedString.Index(range.lowerBound, within: attributed),
              let upper = AttributedString.Index(range.upperBound, within: attributed) else { continue }
        attributed[lower..<upper].link = url
    }
    return attributed
}
