import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// Lock screen + Dynamic Island while someone rides out a craving.
struct RideItOutLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RideItOutAttributes.self) { context in
            RideItOutLockScreen(context: context)
                .activityBackgroundTint(AndiPalette.background)
                .activitySystemActionForegroundColor(AndiPalette.text)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    UrgeRing(state: context.state, isStale: context.isStale, size: 44)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 0) {
                        Text("day \(context.attributes.day)")
                            .font(.system(.caption, design: .rounded).weight(.semibold))
                            .foregroundStyle(AndiPalette.muted)
                        if !done(context) {
                            Text(context.state.startedAt, style: .timer)
                                .font(.system(.title3, design: .rounded).weight(.medium))
                                .monospacedDigit()
                                .multilineTextAlignment(.trailing)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(done(context) ? "you rode it out" : "riding it out with andi")
                        .font(.system(.headline, design: .rounded))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    RideItOutActions(done: done(context))
                        .padding(.top, 6)
                }
            } compactLeading: {
                Image(systemName: "wind")
                    .foregroundStyle(AndiPalette.accent)
            } compactTrailing: {
                if done(context) {
                    Image(systemName: "checkmark")
                        .foregroundStyle(AndiPalette.low)
                } else {
                    Text(context.state.startedAt, style: .timer)
                        .monospacedDigit()
                        .frame(maxWidth: 44)
                        .foregroundStyle(AndiPalette.accent)
                }
            } minimal: {
                Image(systemName: done(context) ? "checkmark" : "wind")
                    .foregroundStyle(done(context) ? AndiPalette.low : AndiPalette.accent)
            }
            .widgetURL(AndiRoute.breathe.url)
            .keylineTint(AndiPalette.accent)
        }
    }

    private func done(_ context: ActivityViewContext<RideItOutAttributes>) -> Bool {
        context.state.resolved || context.isStale
    }
}

private struct RideItOutLockScreen: View {
    let context: ActivityViewContext<RideItOutAttributes>

    private var done: Bool { context.state.resolved || context.isStale }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                UrgeRing(state: context.state, isStale: context.isStale, size: 52)
                VStack(alignment: .leading, spacing: 2) {
                    Text(done ? "you rode it out" : "riding it out")
                        .font(.system(.headline, design: .rounded))
                        .foregroundStyle(AndiPalette.text)
                    Text(done ? "day \(context.attributes.day). that counts." : "urges rise and fall. this one will pass.")
                        .font(.system(.caption, design: .rounded))
                        .foregroundStyle(AndiPalette.muted)
                }
                Spacer(minLength: 0)
                if !done {
                    Text(context.state.startedAt, style: .timer)
                        .font(.system(.title2, design: .rounded).weight(.light))
                        .monospacedDigit()
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 80, alignment: .trailing)
                        .foregroundStyle(AndiPalette.text)
                }
            }
            RideItOutActions(done: done)
        }
        .padding(16)
    }
}

/// The urge window as a ring that fills over ~20 minutes.
private struct UrgeRing: View {
    let state: RideItOutAttributes.ContentState
    let isStale: Bool
    let size: CGFloat

    var body: some View {
        let done = state.resolved || isStale
        ZStack {
            Circle()
                .stroke(AndiPalette.accent.opacity(0.18), lineWidth: 4)
            if done {
                Circle().stroke(AndiPalette.low, lineWidth: 4)
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.32, weight: .semibold))
                    .foregroundStyle(AndiPalette.low)
            } else {
                ProgressView(timerInterval: state.startedAt...state.endsAt, countsDown: false) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .progressViewStyle(.circular)
                .tint(AndiPalette.accent)
                Image(systemName: "wind")
                    .font(.system(size: size * 0.32, weight: .medium))
                    .foregroundStyle(AndiPalette.accent)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct RideItOutActions: View {
    let done: Bool

    var body: some View {
        HStack(spacing: 10) {
            Link(destination: AndiRoute.text.url) {
                Label("text andi", systemImage: "message.fill")
                    .font(.system(.subheadline, design: .rounded).weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(Capsule().fill(AndiPalette.accent))
                    .foregroundStyle(Color.black)
            }
            if !done {
                Button(intent: EndRideIntent()) {
                    Text("i'm okay")
                        .font(.system(.subheadline, design: .rounded).weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(Capsule().fill(Color.white.opacity(0.12)))
                        .foregroundStyle(AndiPalette.text)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

#Preview("lock screen", as: .content, using: RideItOutAttributes(day: 12)) {
    RideItOutLiveActivity()
} contentStates: {
    RideItOutAttributes.ContentState(startedAt: .now.addingTimeInterval(-272), endsAt: .now.addingTimeInterval(928), resolved: false)
    RideItOutAttributes.ContentState(startedAt: .now.addingTimeInterval(-1200), endsAt: .now, resolved: true)
}
