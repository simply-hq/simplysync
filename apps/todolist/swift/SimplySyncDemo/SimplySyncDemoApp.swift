import SwiftUI

@main
struct SimplySyncDemoApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            if let engine = model.engine {
                if model.isRestoringOwner {
                    RestoreOwnerView(model: model)
                } else if model.needsRecoveryConfirmation {
                    RecoveryBackupView(model: model)
                } else {
                    TodoView(engine: engine, model: model)
                }
            } else {
                OnboardingView(model: model)
            }
        }
    }
}
