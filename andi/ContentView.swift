import SwiftUI

/// Root: picks onboarding / linking / home from `model.phase`.
/// Expects an `AppModel` in the environment (MyApp, or `AppModel.preview()` in previews).
struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var booted = false

    var body: some View {
        Group {
            if !booted {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.background.ignoresSafeArea())
                    .accessibilityLabel("loading")
            } else {
                switch model.phase {
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
        .onChange(of: scenePhase) { _, newPhase in
            // Coming back to the app: pick up the latest day count, risk and link state.
            guard booted, newPhase == .active, model.phase != .onboarding else { return }
            Task { await model.refresh() }
        }
    }
}

#Preview("home") {
    ContentView().environment(AppModel.preview())
}

#Preview("onboarding") {
    ContentView().environment(AppModel.preview(.onboarding, me: nil))
}
