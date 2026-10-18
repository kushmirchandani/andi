import SwiftUI
import WidgetKit

// Lock screen (circular, rectangular, inline) and home screen (small) day count.
// Tapping the rectangular one starts "ride it out"; the rest open the app.

struct DayEntry: TimelineEntry {
    let date: Date
    let snapshot: AndiSnapshot?

    var day: Int { snapshot?.day(on: date) ?? 0 }
    var risk: String? { snapshot?.risk }
}

struct DayProvider: TimelineProvider {
    func placeholder(in context: Context) -> DayEntry {
        DayEntry(date: .now, snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (DayEntry) -> Void) {
        completion(DayEntry(date: .now, snapshot: AndiSnapshot.load() ?? .placeholder))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DayEntry>) -> Void) {
        let snapshot = AndiSnapshot.load()
        let now = Date.now
        let calendar = Calendar.current
        // Today, then each of the next few midnights so the count ticks over on its own.
        var entries = [DayEntry(date: now, snapshot: snapshot)]
        var next = calendar.startOfDay(for: now)
        for _ in 0..<3 {
            next = calendar.date(byAdding: .day, value: 1, to: next) ?? next.addingTimeInterval(86_400)
            entries.append(DayEntry(date: next, snapshot: snapshot))
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

struct DayWidget: Widget {
    let kind = "AndiDay"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: DayProvider()) { entry in
            DayWidgetView(entry: entry)
        }
        .configurationDisplayName("Your days")
        .description("Your day count. Tap when it's a hard moment.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .systemSmall])
    }
}

struct DayWidgetView: View {
    let entry: DayEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular: circular
        case .accessoryRectangular: rectangular
        case .accessoryInline: inline
        default: small
        }
    }

    private var signedOut: Bool { entry.snapshot == nil }

    // Day count inside a ring, like the app's home screen.
    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            Circle()
                .strokeBorder(lineWidth: 2.5)
                .opacity(0.9)
                .padding(2)
            VStack(spacing: -2) {
                Text(signedOut ? "–" : "\(entry.day)")
                    .font(.system(size: 22, weight: .medium, design: .rounded))
                    .monospacedDigit()
                    .minimumScaleFactor(0.5)
                Text(entry.day == 1 ? "day" : "days")
                    .font(.system(size: 9, weight: .semibold, design: .rounded))
                    .textCase(.lowercase)
                    .opacity(0.8)
            }
            .padding(6)
        }
        .widgetAccentable()
        .containerBackground(for: .widget) { Color.clear }
        .widgetURL(AndiRoute.home.url)
        .accessibilityLabel(signedOut ? "andi" : "\(entry.day) days, andi")
    }

    // The craving entry point on the lock screen.
    private var rectangular: some View {
        HStack(spacing: 8) {
            Circle()
                .strokeBorder(lineWidth: 2)
                .frame(width: 22, height: 22)
                .widgetAccentable()
            VStack(alignment: .leading, spacing: 1) {
                Text(signedOut ? "andi" : "day \(entry.day)")
                    .font(.system(.headline, design: .rounded))
                    .widgetAccentable()
                Text("hard moment? tap to ride it out")
                    .font(.caption2)
                    .lineLimit(2)
                    .opacity(0.85)
            }
            Spacer(minLength: 0)
        }
        .containerBackground(for: .widget) { Color.clear }
        .widgetURL(AndiRoute.breathe.url)
        .accessibilityLabel(signedOut ? "andi. tap to ride it out" : "day \(entry.day). tap to ride it out with andi")
    }

    private var inline: some View {
        Text(signedOut ? "andi's up" : "day \(entry.day) · andi's up")
            .containerBackground(for: .widget) { Color.clear }
            .widgetURL(AndiRoute.home.url)
    }

    // Home screen: the glowing ring.
    private var small: some View {
        let color = AndiPalette.risk(entry.risk)
        return VStack(spacing: 8) {
            ZStack {
                Circle().fill(color.opacity(0.08))
                Circle()
                    .strokeBorder(color.opacity(0.85), lineWidth: 2.5)
                    .shadow(color: color.opacity(0.5), radius: 10)
                VStack(spacing: -4) {
                    Text(signedOut ? "–" : "\(entry.day)")
                        .font(.system(size: 40, weight: .light, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.5)
                        .foregroundStyle(AndiPalette.text)
                    Text(entry.day == 1 ? "day" : "days")
                        .font(.system(.caption, design: .rounded).weight(.semibold))
                        .foregroundStyle(AndiPalette.muted)
                }
            }
            .frame(width: 104, height: 104)
            Text(signedOut ? "open andi to set up" : "tap if it's a hard moment")
                .font(.system(size: 11, design: .rounded))
                .foregroundStyle(AndiPalette.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .containerBackground(for: .widget) { AndiPalette.background }
        .widgetURL(AndiRoute.breathe.url)
    }
}

#Preview(as: .accessoryRectangular) {
    DayWidget()
} timeline: {
    DayEntry(date: .now, snapshot: .placeholder)
}

#Preview(as: .systemSmall) {
    DayWidget()
} timeline: {
    DayEntry(date: .now, snapshot: .placeholder)
}
