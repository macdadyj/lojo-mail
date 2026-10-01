import LojoMailCore
import SwiftUI
import UIKit

enum Theme {
    /// Teal, a shade lighter in dark mode so body-size text keeps 4.5:1 on grouped cards (#1C1C1E) and a shade
    /// darker in light mode for the same on white.
    static let accent = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.22, green: 0.70, blue: 0.74, alpha: 1)
            : UIColor(red: 0.03, green: 0.45, blue: 0.49, alpha: 1)
    })
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
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 36

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

/// Chips and other short items that wrap onto more lines instead of clipping at large text sizes.
struct FlowLayout: Layout {
    var spacing: CGFloat = 5
    var lineSpacing: CGFloat = 5

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let lines = arrange(subviews, width: proposal.width ?? .infinity)
        let width = lines.map(\.width).max() ?? 0
        let height = lines.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(lines.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in line.indices {
                let size = subviews[index].sizeThatFits(.init(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y + (line.height - size.height) / 2), proposal: .init(width: min(size.width, bounds.width), height: size.height))
                x += min(size.width, bounds.width) + spacing
            }
            y += line.height + lineSpacing
        }
    }

    private struct Line { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [Line] {
        var lines: [Line] = []
        var current = Line()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.init(width: width, height: nil))
            let itemWidth = min(size.width, width)
            if !current.indices.isEmpty && current.width + spacing + itemWidth > width {
                lines.append(current)
                current = Line()
            }
            current.width += (current.indices.isEmpty ? 0 : spacing) + itemWidth
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { lines.append(current) }
        return lines
    }
}

/// Keeps long-form content to a comfortable line length on iPad and in landscape.
extension View {
    func readableWidth(_ maxWidth: CGFloat = 760) -> some View {
        frame(maxWidth: maxWidth).frame(maxWidth: .infinity)
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
