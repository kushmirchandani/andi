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
            case .inhale: "in"
            case .hold: "hold"
            case .exhale: "out"
            }
        }
    }

    @State private var breath: Breath = .inhale
    @State private var expanded = false
    @State private var didLog = false
    @ScaledMetric(relativeTo: .largeTitle) private var circleSize: CGFloat = 260

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 40) {
                Spacer()

                ZStack {
                    Circle()
                        .fill(Theme.accent.opacity(0.16))
                    Circle()
                        .strokeBorder(Theme.accent.opacity(0.6), lineWidth: 2)
                }
                .frame(width: circleSize, height: circleSize)
                .scaleEffect(reduceMotion ? 0.8 : (expanded ? 1 : 0.45))
                .opacity(reduceMotion ? (expanded ? 1 : 0.45) : 1)
                .accessibilityHidden(true)

                VStack(spacing: 8) {
                    Text(breath.label)
                        .accessibilityLabel("breathe \(breath.label)")
                        .font(.system(.largeTitle, design: .rounded).weight(.light))
                        .contentTransition(.opacity)
                        .animation(.easeInOut(duration: 0.4), value: breath)
                    Text("in for 4 · hold for 4 · out for 6")
                        .font(Theme.caption)
                        .foregroundStyle(Theme.muted)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)

                Spacer()

                Button("i'm done") { dismiss() }
                    .buttonStyle(.andiSecondary)
                    .padding(.horizontal, Theme.gutter)
                    .padding(.bottom, 24)
            }
        }
        .overlay(alignment: .topTrailing) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(Theme.headline)
                    .padding(12)
                    .background(Circle().fill(Theme.card))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.muted)
            .padding(Theme.gutter)
            .accessibilityLabel("close")
        }
        .andiHaptic(.light, trigger: breath)
        .task { await breatheLoop() }
        .task {
            guard !didLog else { return }
            didLog = true
            await model.breathe()
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
