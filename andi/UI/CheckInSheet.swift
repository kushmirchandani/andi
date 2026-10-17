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
            Form {
                Section {
                    Toggle(isOn: $checkIn.hungry) { Label("hungry", systemImage: "fork.knife") }
                    Toggle(isOn: $checkIn.angry) { Label("angry", systemImage: "flame") }
                    Toggle(isOn: $checkIn.lonely) { Label("lonely", systemImage: "person") }
                    Toggle(isOn: $checkIn.tired) { Label("tired", systemImage: "moon.zzz") }
                } header: {
                    Text("right now, are you…")
                } footer: {
                    Text("any one of these can make things harder. noticing it is the point.")
                }

                Section {
                    Picker("mood", selection: $checkIn.mood) {
                        Text("skip").tag(Int?.none)
                        ForEach(1...5, id: \.self) { value in
                            Text("\(value)").tag(Int?.some(value))
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                } header: {
                    Text("how's your mood?")
                } footer: {
                    Text("1 is rough, 5 is good.")
                }

                Section {
                    TextField("a few words, if you want", text: $note, axis: .vertical)
                        .lineLimit(2...6)
                        .focused($noteFocused)
                        .onChange(of: note) { _, newValue in
                            if newValue.count > Self.noteLimit { note = String(newValue.prefix(Self.noteLimit)) }
                        }
                } header: {
                    Text("anything else?")
                } footer: {
                    if note.count > Self.noteLimit - 50 {
                        Text("\(Self.noteLimit - note.count) characters left")
                    }
                }

                if let safetyText {
                    Section {
                        Text(safetyText)
                        if let call = CrisisLine.call988 {
                            Link(destination: call) { Label("call 988", systemImage: "phone.fill") }
                        }
                        if let text = CrisisLine.text988 {
                            Link(destination: text) { Label("text 988", systemImage: "message.fill") }
                        }
                    } header: {
                        Text("you don't have to carry this alone")
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(Theme.riskElevated)
                    }
                }
            }
            .formStyle(.grouped)
            .scrollDismissesKeyboard(.interactively)
            .keyboardDoneButton { noteFocused = false }
            .andiScreenBackground()
            .navigationTitle("check in")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSending {
                        ProgressView()
                    } else {
                        Button("send") { send() }
                            .disabled(isSending)
                    }
                }
            }
        }
        .tint(Theme.accent)
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

#Preview {
    let model = AppModel.preview()
    return Text("home")
        .sheet(isPresented: .constant(true)) {
            CheckInSheet().environment(model)
        }
        .environment(model)
        .preferredColorScheme(.dark)
}
