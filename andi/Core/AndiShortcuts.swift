import AppIntents

/// Siri / Spotlight / Shortcuts phrases, and what shows under "Andi" when picking a Shortcut for the Action Button.
struct AndiShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: RideItOutIntent(),
            phrases: [
                "Ride it out with \(.applicationName)",
                "I need \(.applicationName)",
                "Breathe with \(.applicationName)",
            ],
            shortTitle: "Ride It Out",
            systemImageName: "wind"
        )
        AppShortcut(
            intent: TextAndiIntent(),
            phrases: [
                "Text \(.applicationName)",
                "Message \(.applicationName)",
            ],
            shortTitle: "Text Andi",
            systemImageName: "message.fill"
        )
    }

    static let shortcutTileColor: ShortcutTileColor = .orange
}
