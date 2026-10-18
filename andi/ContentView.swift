import SwiftUI

/// Root: picks onboarding / linking / home from `model.phase`.
/// Expects an `AppModel` in the environment (MyApp, or `AppModel.preview()` in previews).
struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var booted = false

    /// Debug only: launch with `-personaLab` to jump straight into the persona lab.
    private static var opensPersonaLab: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("-personaLab")
        #else
        false
        #endif
    }

    var body: some View {
        Group {
            if Self.opensPersonaLab {
                NavigationStack { PersonaLabView() }
            } else if !booted {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.background.ignoresSafeArea())
                    .accessibilityLabel("loading")
            } else {
                switch model.phase {
                case .signIn:
                    SignInView()
                case .onboarding:
                    OnboardingView()
                case .linking:
                    LinkingView()
                case .ready:
                    NavigationStack {
                        HomeView()
                    }
                }
            }
        }
        .animation(.easeInOut(duration: 0.3), value: model.phase)
        .animation(.easeInOut(duration: 0.3), value: booted)
        .tint(Theme.accent)
        .preferredColorScheme(.dark)
        .task {
            await model.bootstrap()
            booted = true
        }
        // andi://breathe | text | home, from the widget and the Live Activity. HomeView acts on it.
        .onOpenURL { url in AndiRouter.shared.handle(url) }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active { Task { await RideItOutAttributes.endExpired() } }
            // Coming back to the app: pick up the latest day count, risk and link state.
            guard booted, newPhase == .active, model.phase == .ready || model.phase == .linking else { return }
            Task { await model.refresh() }
        }
    }
}

#Preview("home") {
    ContentView().environment(AppModel.preview())
}

#Preview("sign in") {
    ContentView().environment(AppModel.preview(.signIn, me: nil))
}
