import AppIntents
import SwiftUI
import WidgetKit

// Controls show up in Control Center, on the lock screen's bottom buttons,
// and in Settings > Action Button > Controls. "Ride it out" is the one to put on the Action Button.

struct RideItOutControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "andi.rideitout") {
            ControlWidgetButton(action: RideItOutIntent()) {
                Label("Ride It Out", systemImage: "wind")
            }
        }
        .displayName("Ride It Out")
        .description("Breathe with Andi through a craving.")
    }
}

struct TextAndiControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "andi.text") {
            ControlWidgetButton(action: TextAndiIntent()) {
                Label("Text Andi", systemImage: "message.fill")
            }
        }
        .displayName("Text Andi")
        .description("Open your conversation with Andi.")
    }
}
