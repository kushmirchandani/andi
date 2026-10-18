import Foundation
import SwiftUI
import Observation

// Compiled into both the app and the AndiWidgets extension.
// Keep it free of app-only types (AppModel, APIClient, Theme).

// MARK: - App Group snapshot (what the lock screen widget shows)

/// The little bit of state the widget needs. The app writes it whenever `me` refreshes.
/// Lives in the App Group's UserDefaults; if the group isn't available the widget shows its placeholder.
nonisolated struct AndiSnapshot: Codable, Sendable, Equatable {
    static let appGroup = "group.com.kushmirchandani.andi"
    private static let key = "andi.snapshot"

    var day: Int
    /// When `day` was true. The widget adds calendar days since then, so the count rolls over at midnight
    /// even if the app hasn't been opened.
    var asOf: Date
    /// "low" | "elevated" | "high"
    var risk: String?
    var sponsorName: String?

    static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    static func load() -> AndiSnapshot? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(AndiSnapshot.self, from: data)
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        Self.defaults?.set(data, forKey: Self.key)
    }

    static func clear() {
        defaults?.removeObject(forKey: key)
    }

    /// The day count on `date`.
    func day(on date: Date, calendar: Calendar = .current) -> Int {
        let from = calendar.startOfDay(for: asOf)
        let to = calendar.startOfDay(for: date)
        let elapsed = calendar.dateComponents([.day], from: from, to: to).day ?? 0
        return max(day + max(elapsed, 0), 0)
    }

    /// Same thing on screen (ignores `asOf` when the day hasn't changed), so the app doesn't reload widgets on every refresh.
    func looksSame(as other: AndiSnapshot?) -> Bool {
        guard let other else { return false }
        return day(on: .now) == other.day(on: .now) && risk == other.risk && sponsorName == other.sponsorName
    }

    static let placeholder = AndiSnapshot(day: 12, asOf: .now, risk: "low", sponsorName: "sam")
}

// MARK: - Deep links and routing

/// Where an entry point (widget, Live Activity, control, Action Button, Siri) wants the app to go.
nonisolated enum AndiRoute: String, Sendable, Equatable {
    /// Ride it out: the breathing screen, the Live Activity, and Andi texts first.
    case breathe
    /// Open Messages to Andi.
    case text
    case home

    /// andi://breathe, andi://text, andi://home
    var url: URL { URL(string: "andi://\(rawValue)")! }

    init?(url: URL) {
        guard url.scheme?.lowercased() == "andi" else { return nil }
        let name = url.host() ?? url.path().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.init(rawValue: name.lowercased())
    }
}

/// One pending route the UI picks up when it's ready (cold launches included).
@MainActor @Observable
final class AndiRouter {
    static let shared = AndiRouter()

    private(set) var pending: AndiRoute?

    func open(_ route: AndiRoute) { pending = route }

    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard let route = AndiRoute(url: url) else { return false }
        pending = route
        return true
    }

    /// Returns the pending route once and clears it.
    func consume() -> AndiRoute? {
        defer { pending = nil }
        return pending
    }
}

// MARK: - Palette (mirror of Theme in the app; the extension can't see Theme)

nonisolated enum AndiPalette {
    static let background = rgb(0x0E0D0C)
    static let text = rgb(0xF4EFE8)
    static let muted = rgb(0xA39C93)
    static let accent = rgb(0xFF6A2B)
    static let low = rgb(0x4FC6A8)
    static let elevated = rgb(0xF2B33D)
    static let high = rgb(0xE5482E)

    private static func rgb(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    static func risk(_ level: String?) -> Color {
        switch level {
        case "high": high
        case "elevated": elevated
        default: low
        }
    }

    static func riskLine(_ level: String?) -> String {
        switch level {
        case "high": "today looks hard. andi's right here."
        case "elevated": "a little wobbly. go gently."
        default: "steady. one day at a time."
        }
    }
}
