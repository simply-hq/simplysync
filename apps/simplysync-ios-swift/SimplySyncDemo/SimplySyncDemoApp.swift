import SwiftUI

@main
struct SimplySyncDemoApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            if let engine = model.engine {
                TodoView(engine: engine, model: model, onSignOut: { model.signOut() })
            } else {
                OnboardingView(model: model)
            }
        }
    }
}
