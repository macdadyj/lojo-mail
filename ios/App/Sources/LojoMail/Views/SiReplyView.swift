import LojoMailCore
import SwiftUI

/// Instruction and tone, then a draft in Compose. This view has no send button.
struct SiReplyView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var message: Message
    var threadText: String
    var onDraft: (DraftView) -> Void

    @State private var screen = SiReplyScreen()
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                Text("SI writes a draft from this conversation. It opens in Compose for you to edit. Nothing is sent until you approve it there.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Tone") {
                FlowLayout {
                    ForEach(SiTone.allCases, id: \.self) { tone in
                        Button {
                            screen.tone = tone
                        } label: {
                            Chip(text: tone.title, systemImage: screen.tone == tone ? "checkmark" : nil, tint: screen.tone == tone ? Theme.accent : .secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("si.tone.\(tone.rawValue)")
                        .accessibilityAddTraits(screen.tone == tone ? .isSelected : [])
                    }
                }
                .padding(.vertical, 4)
            }
            Section("Instruction") {
                TextField("Optional, such as “say yes, propose Tuesday”", text: $screen.instruction, axis: .vertical)
                    .lineLimit(3...6)
                    .accessibilityIdentifier("si.reply.instruction")
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            Section {
                Button {
                    Task { await generate() }
                } label: {
                    if busy { ProgressView() } else { Text("Write draft") }
                }
                .disabled(busy || !screen.canGenerate)
                .accessibilityIdentifier("si.reply.generate")
            }
        }
        .navigationTitle("Reply with SI")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
        }
    }

    private func generate() async {
        guard screen.canGenerate, !screen.sendsAutomatically else { return }
        busy = true
        defer { busy = false }
        let messageId = message.id
        let tone = screen.tone
        let instruction = screen.instruction
        let sourceText = model.bodyText(message)
        let earlier = threadText
        do {
            let view = try await model.call {
                try await $0.siReply(messageId: messageId, tone: tone, instruction: instruction, sourceText: sourceText, threadText: earlier)
            }
            model.upsertDraft(view)
            dismiss()
            onDraft(view)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
