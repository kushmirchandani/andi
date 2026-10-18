import Foundation
import ActivityKit

/// The "riding it out" Live Activity: starts when someone opens a breathing round
/// (Action Button, control, widget, Siri, or the app) and stays on the lock screen and
/// Dynamic Island through the urge window, so Andi is still there after they put the phone down.
nonisolated struct RideItOutAttributes: ActivityAttributes {
    nonisolated struct ContentState: Codable, Hashable, Sendable {
        var startedAt: Date
        /// Cravings usually rise and fall within 15 to 30 minutes.
        var endsAt: Date
        /// They tapped "i'm okay" (or the window passed).
        var resolved: Bool
    }

    /// Their day count when the round started.
    var day: Int

    /// How long the activity tracks the urge.
    static let window: TimeInterval = 20 * 60

    /// Ends every ride-it-out activity, showing "you rode it out" briefly first.
    static func endAll() async {
        for activity in Activity<RideItOutAttributes>.activities {
            var state = activity.content.state
            state.resolved = true
            await activity.end(ActivityContent(state: state, staleDate: nil),
                               dismissalPolicy: .after(.now.addingTimeInterval(5 * 60)))
        }
    }

    /// Ends activities whose urge window is long over (the app calls this when it comes to the front).
    static func endExpired() async {
        let cutoff = Date.now.addingTimeInterval(-10 * 60)
        for activity in Activity<RideItOutAttributes>.activities where activity.content.state.endsAt < cutoff {
            var state = activity.content.state
            state.resolved = true
            await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .immediate)
        }
    }
}
