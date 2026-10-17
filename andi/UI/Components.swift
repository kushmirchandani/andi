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
        .tint(Theme.accent)
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
                if model.phase == .onboarding {
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
        .environment(AppModel.preview(.onboarding, me: nil))
        .preferredColorScheme(.dark)
}
