import SwiftUI

// Small shared pieces used across screens.

// MARK: - Crisis lines

enum CrisisLine {
    static let call988 = URL(string: "tel:988")
    static let text988 = URL(string: "sms:988")
    static let samhsa = URL(string: "tel:18006624357")
}

/// A quiet, always-visible "in crisis?" line with call/text links to 988.
struct CrisisFooter: View {
    var body: some View {
        HStack(spacing: 6) {
            Text("in crisis?")
                .foregroundStyle(Theme.muted)
            if let call = CrisisLine.call988 {
                Link("call", destination: call)
                    .accessibilityLabel("call 988, the crisis line")
            }
            Text("or")
                .foregroundStyle(Theme.muted)
                .accessibilityHidden(true)
            if let text = CrisisLine.text988 {
                Link("text 988", destination: text)
                    .accessibilityLabel("text 988, the crisis line")
            }
        }
        .font(Theme.caption)
        .tint(Theme.ember)
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Error banner

/// Inline error with an optional retry.
struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(Theme.riskElevated)
                .accessibilityHidden(true)
            Text(message)
                .font(Theme.caption)
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button("try again", action: retry)
                    .font(Theme.caption.weight(.semibold))
                    .foregroundStyle(Theme.accent)
            }
        }
        .andiCard()
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Haptics (iOS only)

enum AndiHaptic {
    case success, light, warning
}

extension View {
    /// Plays a haptic when `trigger` changes. No-op off iPhone/iPad.
    @ViewBuilder func andiHaptic<T: Equatable>(_ haptic: AndiHaptic, trigger: T) -> some View {
        #if os(iOS)
        switch haptic {
        case .success: sensoryFeedback(.success, trigger: trigger)
        case .light: sensoryFeedback(.impact(weight: .light), trigger: trigger)
        case .warning: sensoryFeedback(.warning, trigger: trigger)
        }
        #else
        self
        #endif
    }

    /// Adds a "done" button above the keyboard (iOS only).
    @ViewBuilder func keyboardDoneButton(_ action: @escaping () -> Void) -> some View {
        #if os(iOS)
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("done", action: action)
            }
        }
        #else
        self
        #endif
    }
}

// MARK: - Server sheet (developer)

/// Lets a developer point the app at another backend, and (DEBUG) switch to sample data.
struct ServerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var text = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://your-server.example.com", text: $text)
                        .urlInput()
                        .onSubmit(apply)
                    if let error {
                        Text(error).foregroundStyle(Theme.riskElevated)
                    }
                } header: {
                    Text("server")
                } footer: {
                    if AppConfig.overrideBaseURL != nil {
                        Text("ANDI_BASE_URL is set in the scheme, so it wins over this setting.")
                    } else {
                        Text("default: \(AppConfig.defaultBaseURLString)")
                    }
                }
                .listRowBackground(Theme.card)

                Section {
                    Button("use the default server") {
                        model.resetBaseURL()
                        text = model.baseURL.absoluteString
                        error = nil
                    }
                }
                .listRowBackground(Theme.card)

                #if DEBUG
                if model.phase == .signIn {
                    Section {
                        Button("try with sample data") {
                            model.startDemo()
                            dismiss()
                        }
                    } footer: {
                        Text("no server needed. sign out in settings to leave demo mode.")
                    }
                    .listRowBackground(Theme.card)
                }
                #endif
            }
            .formStyle(.grouped)
            .andiScreenBackground()
            .navigationTitle("developer")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("save", action: apply)
                        .disabled(text.andiTrimmed.isEmpty)
                }
            }
            .onAppear { text = model.baseURL.absoluteString }
        }
        .tint(Theme.accent)
    }

    private func apply() {
        guard let url = AppConfig.parseServerURL(text) else {
            error = "that doesn't look like a web address."
            return
        }
        error = nil
        model.setBaseURL(url)
        dismiss()
    }
}

// MARK: - Brand + layout pieces

/// The small "andi" mark at the top of the sign-in screens.
struct AndiWordmark: View {
    var body: some View {
        HStack(spacing: 7) {
            Circle()
                .strokeBorder(Theme.text, lineWidth: 3)
                .frame(width: 15, height: 15)
            Text("andi")
                .font(.system(.title3, design: .rounded).weight(.semibold))
        }
        .foregroundStyle(Theme.text)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("andi")
    }
}

/// An SF Symbol in a softly glowing ring, used as a screen's hero mark.
struct GlowIcon: View {
    let symbol: String
    var color: Color = Theme.accent
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 88

    var body: some View {
        ZStack {
            Circle().fill(color.opacity(0.10))
            Circle().strokeBorder(color.opacity(0.35), lineWidth: 1)
            Image(systemName: symbol)
                .font(.system(size: size * 0.38))
                .foregroundStyle(color)
        }
        .frame(width: size, height: size)
        .shadow(color: color.opacity(0.35), radius: 30)
        .accessibilityHidden(true)
    }
}

/// Thin segmented progress bars across the top of a multi-step flow.
struct StepBars: View {
    let count: Int
    let current: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index <= current ? Theme.text : Color.white.opacity(0.14))
                    .frame(height: 3)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: current)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("step \(current + 1) of \(count)")
    }
}

/// A round glass icon button (back, close).
struct CircleIconButton: View {
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(Theme.text)
                .frame(width: 44, height: 44)
                .background(Circle().fill(Theme.card))
                .overlay(Circle().strokeBorder(Theme.hairline))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// A tappable choice row. Fills cream when selected.
struct OptionRow: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(title)
                    .font(.body.weight(.medium))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Theme.onPrimary : Theme.faint)
            }
            .padding(.vertical, 16)
            .padding(.horizontal, 18)
            .foregroundStyle(selected ? Theme.onPrimary : Theme.text)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous).fill(selected ? Theme.primary : Theme.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(selected ? .clear : Theme.hairline)
            )
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.15), value: selected)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .andiHaptic(.light, trigger: selected)
    }
}

/// What to send Andi, drawn as the message they're about to send.
struct MessagePreview: View {
    let to: String?
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Text("to").andiLabel()
                Text(to.map(PhoneNumber.display) ?? "andi")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.text)
                    .textSelection(.enabled)
                Spacer()
            }
            HStack {
                Spacer()
                Text(text)
                    .font(.body.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 15)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 19, style: .continuous)
                            .fill(Color(red: 0.04, green: 0.52, blue: 1.0))
                    )
                    .textSelection(.enabled)
            }
        }
        .andiCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("send \(text) to \(to ?? "andi")")
    }
}

/// A softly pulsing dot with a status line ("waiting for your text…").
struct WaitingIndicator: View {
    let text: String
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Theme.accent)
                .frame(width: 8, height: 8)
                .shadow(color: Theme.accent.opacity(0.8), radius: pulse ? 8 : 2)
                .opacity(pulse ? 0.35 : 1)
            Text(text)
                .font(Theme.caption)
                .foregroundStyle(Theme.muted)
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.1).repeatForever()) { pulse = true }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("crisis footer + error") {
    VStack(spacing: 20) {
        ErrorBanner(message: "you're offline. check your connection and try again.") {}
        CrisisFooter()
    }
    .padding()
    .background(Theme.background)
    .preferredColorScheme(.dark)
}

#Preview("server sheet") {
    ServerSheet()
        .environment(AppModel.preview(.signIn, me: nil))
        .preferredColorScheme(.dark)
}
