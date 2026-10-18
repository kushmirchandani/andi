import ActivityKit
import Foundation
import WidgetKit

/// Keeps the lock screen widget's snapshot in step with `me`.
enum WidgetSync {
    static func publish(_ me: Me) {
        let snapshot = AndiSnapshot(day: me.day, asOf: .now, risk: me.risk?.level.rawValue,
                                    sponsorName: me.sponsor.flatMap { $0.name.isEmpty ? nil : $0.name })
        guard !snapshot.looksSame(as: AndiSnapshot.load()) else { return }
        snapshot.save()
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func clear() {
        AndiSnapshot.clear()
        WidgetCenter.shared.reloadAllTimelines()
    }
}

/// Starts the "riding it out" Live Activity (one at a time).
enum RideItOut {
    static func start(day: Int) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let live = Activity<RideItOutAttributes>.activities.contains {
            $0.activityState == .active && !$0.content.state.resolved && $0.content.state.endsAt > .now
        }
        guard !live else { return }
        let now = Date.now
        let state = RideItOutAttributes.ContentState(startedAt: now, endsAt: now.addingTimeInterval(RideItOutAttributes.window),
                                                     resolved: false)
        // Stale a little after the window: the lock screen flips to "you rode it out".
        let content = ActivityContent(state: state, staleDate: state.endsAt.addingTimeInterval(60))
        _ = try? Activity.request(attributes: RideItOutAttributes(day: max(day, 0)), content: content, pushType: nil)
    }
}
