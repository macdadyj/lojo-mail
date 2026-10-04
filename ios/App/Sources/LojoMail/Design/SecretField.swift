import SwiftUI

/// A secret text field with a show/hide (eye) button. Hidden again whenever the app leaves the foreground, so the
/// app switcher snapshot never shows it. Autocorrect, autocapitalisation and spell checking are off in both modes.
struct SecretField: View {
    var title: String
    @Binding var text: String
    /// What it is, for VoiceOver and the eye button ("passphrase", "key").
    var noun: String
    var contentType: UITextContentType? = .password
    var multiline = false
    var submitLabel: SubmitLabel = .done
    var onSubmit: () -> Void = {}

    @State private var revealed = false
    @FocusState private var focused: Bool
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        HStack(alignment: multiline && revealed ? .top : .center, spacing: 8) {
            field
                .focused($focused)
                .textContentType(contentType)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .privacySensitive()
                .submitLabel(submitLabel)
                .onSubmit(onSubmit)
                .accessibilityLabel(title)
            Button {
                let wasFocused = focused
                revealed.toggle()
                if wasFocused { Task { @MainActor in focused = true } }
            } label: {
                Image(systemName: revealed ? "eye.slash" : "eye")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(revealed ? "Hide \(noun)" : "Show \(noun)")
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { revealed = false } }
    }

    @ViewBuilder
    private var field: some View {
        if revealed {
            if multiline {
                TextField(title, text: $text, axis: .vertical)
                    .lineLimit(3...8)
                    .font(.footnote.monospaced())
            } else {
                TextField(title, text: $text)
            }
        } else {
            SecureField(title, text: $text)
                .font(multiline ? .footnote.monospaced() : .body)
        }
    }
}
