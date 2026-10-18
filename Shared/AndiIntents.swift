import AppIntents
import Foundation

// Compiled into the app and the widget extension (controls need the intent in both).
// The open-app intents run in the app's process, where `AndiRouter.shared` drives the UI.

/// The craving button. Opens the breathing screen, starts the Live Activity, and Andi texts first.
/// Assign it to the Action Button (Settings > Action Button > Controls > Andi, or Shortcut > Andi).
struct RideItOutIntent: AppIntent {
    static let title: LocalizedStringResource = "Ride It Out"
    static let description = IntentDescription("Breathe with Andi through a craving. Andi texts you and stays on your lock screen until it passes.")
    static let openAppWhenRun = true

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        AndiRouter.shared.open(.breathe)
        return .result()
    }
}

/// Opens Messages to Andi.
struct TextAndiIntent: AppIntent {
    static let title: LocalizedStringResource = "Text Andi"
    static let description = IntentDescription("Open your conversation with Andi in Messages.")
    static let openAppWhenRun = true

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        AndiRouter.shared.open(.text)
        return .result()
    }
}

/// "i'm okay" on the Live Activity. Ends it without opening the app.
struct EndRideIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "I'm Okay"
    static let description = IntentDescription("End the ride-it-out session.")
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        await RideItOutAttributes.endAll()
        return .result()
    }
}
