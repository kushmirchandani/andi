import SwiftUI

@main struct MyApp: App {
    // Created with the App (also on background relaunches for geofence events),
    // so the location monitor is resumed before any scene exists.
    @State private var model = AppModel(demo: AppConfig.demoRequested)

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
        }
    }
}
