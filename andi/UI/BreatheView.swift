import SwiftUI

/// 4-4-6 breathing: in 4s, hold 4s, out 6s, looping.
struct BreatheView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Breath: Equatable {
        case inhale, hold, exhale

        var label: String {
            switch self {
            case .inhale: "breathe in"
            case .hold: "hold"
            case .exhale: "breathe out"
            }
        }
    }

    @State private var breath: Breath = .inhale
    @State private var expanded = false
    @State private var didLog = false
    @ScaledMetric(relativeTo: .largeTitle) private var circleSize: CGFloat = 260

    var body: some View {
        ZStack {
            AndiGlow(anchor: 0.38)

            VStack(spacing: 0) {
                HStack {
                    CircleIconButton(symbol: "xmark", label: "close") { dismiss() }
                    Spacer()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.top, 8)

                Spacer()

                ZStack {
                    ring
                        .frame(width: circleSize, height: circleSize)
                        .scaleEffect(reduceMotion ? 0.85 : (expanded ? 1 : 0.55))
                        .opacity(reduceMotion ? (expanded ? 1 : 0.5) : 1)
                        .accessibilityHidden(true)

                    Text(breath.label)
                        .accessibilityLabel(breath.label)
                        .font(.system(size: 34, weight: .light))
                        .contentTransition(.opacity)
                        .animation(.easeInOut(duration: 0.4), value: breath)
                        .accessibilityAddTraits(.updatesFrequently)
                }

                Text("in for 4 · hold for 4 · out for 6")
                    .andiLabel()
                    .padding(.top, 36)

                Spacer()

                Button("i'm done") { dismiss() }
                    .buttonStyle(.andiSecondary)
                    .padding(.horizontal, Theme.gutter)
                    .padding(.bottom, 16)
            }
        }
        .andiHaptic(.light, trigger: breath)
        .task { await breatheLoop() }
        .task {
            guard !didLog else { return }
            didLog = true
            // Stays on the lock screen and Dynamic Island after they leave this screen.
            RideItOut.start(day: model.me?.day ?? 0)
            // Andi texts them ("breathing with you…") so the conversation is already open.
            await model.breathe()
        }
    }

    /// A glowing ring, like light through glass.
    private var ring: some View {
        ZStack {
            Circle()
                .fill(RadialGradient(colors: [Theme.accent.opacity(0.0), Theme.accent.opacity(0.14)],
                                     center: .center, startRadius: 0, endRadius: circleSize / 2))
            Circle()
                .strokeBorder(Theme.text.opacity(0.9), lineWidth: 3)
                .shadow(color: Theme.accent.opacity(0.9), radius: 24)
                .shadow(color: Theme.text.opacity(0.5), radius: 6)
        }
    }

    private func breatheLoop() async {
        while !Task.isCancelled {
            breath = .inhale
            // With Reduce Motion the circle only fades (see opacity above) instead of growing.
            withAnimation(.easeInOut(duration: 4)) { expanded = true }
            guard await pause(4) else { return }

            breath = .hold
            guard await pause(4) else { return }

            breath = .exhale
            withAnimation(.easeInOut(duration: 6)) { expanded = false }
            guard await pause(6) else { return }
        }
    }

    /// Returns false if the task was cancelled.
    private func pause(_ seconds: Int) async -> Bool {
        do {
            try await Task.sleep(for: .seconds(seconds))
            return true
        } catch {
            return false
        }
    }
}

#Preview {
    BreatheView()
        .environment(AppModel.preview())
        .preferredColorScheme(.dark)
}
