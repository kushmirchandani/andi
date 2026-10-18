import SwiftUI

struct CheckInSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var checkIn = CheckIn()
    @State private var note = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var safetyText: String?
    @FocusState private var noteFocused: Bool

    private static let noteLimit = 500

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("how are you, really?")
                            .font(Theme.screenTitle)
                        Text("any one of these can make things harder. noticing it is the point.")
                            .font(Theme.body)
                            .foregroundStyle(Theme.muted)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Text("right now, are you…").andiLabel()
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                            FeelingTile(title: "hungry", symbol: "fork.knife", isOn: $checkIn.hungry)
                            FeelingTile(title: "angry", symbol: "flame", isOn: $checkIn.angry)
                            FeelingTile(title: "lonely", symbol: "person", isOn: $checkIn.lonely)
                            FeelingTile(title: "tired", symbol: "moon.zzz", isOn: $checkIn.tired)
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Text("your mood").andiLabel()
                        MoodPicker(mood: $checkIn.mood)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Text("anything else?").andiLabel()
                        TextField("a few words, if you want", text: $note, axis: .vertical)
                            .lineLimit(3...6)
                            .focused($noteFocused)
                            .onChange(of: note) { _, newValue in
                                if newValue.count > Self.noteLimit { note = String(newValue.prefix(Self.noteLimit)) }
                            }
                            .andiCard()
                        if note.count > Self.noteLimit - 50 {
                            Text("\(Self.noteLimit - note.count) characters left")
                                .font(Theme.caption)
                                .foregroundStyle(Theme.muted)
                        }
                    }

                    if let safetyText {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("you don't have to carry this alone")
                                .font(Theme.headline)
                            Text(safetyText)
                                .font(Theme.body)
                                .fixedSize(horizontal: false, vertical: true)
                            HStack(spacing: 10) {
                                if let call = CrisisLine.call988 {
                                    Link(destination: call) { Label("call 988", systemImage: "phone.fill") }
                                        .buttonStyle(.andiUrgent)
                                }
                                if let text = CrisisLine.text988 {
                                    Link(destination: text) { Label("text 988", systemImage: "message.fill") }
                                        .buttonStyle(.andiSecondary)
                                }
                            }
                        }
                        .andiCard()
                    }

                    if let errorMessage {
                        ErrorBanner(message: errorMessage)
                    }
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.top, 8)
                .padding(.bottom, Theme.gutter)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) {
                Button {
                    send()
                } label: {
                    if isSending {
                        ProgressView().tint(Theme.onPrimary)
                    } else {
                        Text("send to andi")
                    }
                }
                .buttonStyle(.andiPrimary)
                .disabled(isSending)
                .padding(.horizontal, Theme.gutter)
                .padding(.top, 12)
                .padding(.bottom, 8)
                .background(Theme.background.opacity(0.92))
            }
            .keyboardDoneButton { noteFocused = false }
            .background(Theme.background.ignoresSafeArea())
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("cancel") { dismiss() }
                }
            }
        }
        .tint(Theme.accent)
        .presentationBackground(Theme.background)
    }

    private func send() {
        guard !isSending else { return }
        noteFocused = false
        isSending = true
        errorMessage = nil
        model.lastError = nil
        var payload = checkIn
        let trimmed = note.andiTrimmed
        payload.note = trimmed.isEmpty ? nil : trimmed
        Task {
            await model.checkIn(payload)
            isSending = false
            if let message = model.safetyMessage {
                // Something they wrote needs a real person: keep the sheet open with 988 right here.
                model.safetyMessage = nil
                withAnimation { safetyText = message }
            } else if let error = model.lastError {
                errorMessage = error
            } else {
                dismiss()
            }
        }
    }
}

// MARK: - Pieces

/// A square-ish toggle tile: glass when off, cream when on.
private struct FeelingTile: View {
    let title: String
    let symbol: String
    @Binding var isOn: Bool

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(isOn ? Theme.onPrimary : Theme.accent)
                Text(title)
                    .font(Theme.headline)
                    .foregroundStyle(isOn ? Theme.onPrimary : Theme.text)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous).fill(isOn ? Theme.primary : Theme.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(isOn ? .clear : Theme.hairline)
            )
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.15), value: isOn)
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .andiHaptic(.light, trigger: isOn)
    }
}

/// 1 (rough) to 5 (good) as five circles. Tap the chosen one again to clear it.
private struct MoodPicker: View {
    @Binding var mood: Int?

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 0) {
                ForEach(1...5, id: \.self) { value in
                    let selected = mood == value
                    Button {
                        mood = selected ? nil : value
                    } label: {
                        Text("\(value)")
                            .font(.title3.weight(.medium))
                            .monospacedDigit()
                            .foregroundStyle(selected ? Theme.onPrimary : Theme.text)
                            .frame(width: 54, height: 54)
                            .background(Circle().fill(selected ? Theme.primary : Theme.card))
                            .overlay(Circle().strokeBorder(selected ? .clear : Theme.hairline))
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("mood \(value) of 5")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            HStack {
                Text("rough")
                Spacer()
                Text("good")
            }
            .font(Theme.caption)
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 12)
            .accessibilityHidden(true)
        }
        .animation(.easeOut(duration: 0.15), value: mood)
        .andiHaptic(.light, trigger: mood)
    }
}

#Preview {
    let model = AppModel.preview()
    return Text("home")
        .sheet(isPresented: .constant(true)) {
            CheckInSheet().environment(model)
        }
        .environment(model)
        .preferredColorScheme(.dark)
}
