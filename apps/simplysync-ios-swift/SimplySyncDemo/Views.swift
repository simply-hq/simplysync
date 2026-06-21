import SwiftUI

/// First-run screen: paste an `sf1_` recovery key or a 24-word BIP39 phrase, or
/// generate a fresh one. Pasting the same credential into a JS/Expo client (or a
/// second simulator) makes them the same owner and they sync.
struct OnboardingView: View {
    @ObservedObject var model: AppModel
    @State private var input = ""

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            VStack(spacing: 8) {
                Text("SimplySync")
                    .font(.largeTitle).bold()
                Text("Native iOS · SwiftUI engine")
                    .font(.subheadline).foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Recovery key or phrase")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("sf1_… or 24 words", text: $input, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .lineLimit(1...4)

                Button("Use this identity") { model.configure(with: input) }
                    .buttonStyle(.borderedProminent)
                    .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("Generate a new identity") { model.generateNewIdentity() }
                    .buttonStyle(.bordered)
            }
            .padding(.horizontal)

            if let error = model.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            Spacer()
        }
        .padding()
    }
}

/// The synced todo list. Reads rows from the engine's reactive `LiveQuery`, writes
/// with `engine.insert`/`update`, shows live `engine.syncState`, and lets you edit
/// the relay URL and reveal the recovery key (to mirror the owner elsewhere).
struct TodoView: View {
    @ObservedObject var engine: SyncEngine
    @ObservedObject var model: AppModel
    @StateObject private var todos: LiveQuery<TodoRow>
    let onSignOut: () -> Void

    @State private var newTitle = ""
    @State private var showKey = false

    init(engine: SyncEngine, model: AppModel, onSignOut: @escaping () -> Void) {
        self.engine = engine
        self.model = model
        self.onSignOut = onSignOut
        _todos = StateObject(wrappedValue: engine.liveQuery(todosQuery))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                relayBar
                addBar
                List {
                    ForEach(todos.rows) { todo in
                        HStack {
                            Image(systemName: todo.done ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(todo.done ? .green : .secondary)
                            Text(todo.title)
                                .strikethrough(todo.done)
                                .foregroundStyle(todo.done ? .secondary : .primary)
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { toggle(todo) }
                    }
                    .onDelete { indexSet in indexSet.map { todos.rows[$0] }.forEach(delete) }
                }
                .listStyle(.plain)
            }
            .navigationTitle("Todos")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { statusPill }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(showKey ? "Hide recovery key" : "Show recovery key") { showKey.toggle() }
                        Button("Sign out", role: .destructive, action: onSignOut)
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if showKey, let key = engine.currentOwner?.recoveryKey {
                    Text(key)
                        .font(.caption2.monospaced())
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity)
                        .background(.thinMaterial)
                }
            }
        }
    }

    private var relayBar: some View {
        HStack {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .foregroundStyle(.secondary)
            TextField("relay url", text: $model.relayURLString)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.callout.monospaced())
            Button("Sync") { Task { await engine.sync() } }
                .buttonStyle(.bordered)
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }

    private var addBar: some View {
        HStack {
            TextField("Add a todo…", text: $newTitle)
                .textFieldStyle(.roundedBorder)
                .onSubmit(add)
            Button("Add", action: add)
                .buttonStyle(.borderedProminent)
                .disabled(newTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding()
    }

    private var statusPill: some View {
        let (label, color): (String, Color) = {
            switch engine.syncState {
            case .initial: return ("idle", .gray)
            case .syncing: return ("syncing", .orange)
            case .synced: return ("synced", .green)
            case .notSynced(let error, _, let status):
                if let status { return ("HTTP \(status)", .red) }
                return (error?.isEmpty == false ? "offline" : "offline", .red)
            }
        }()
        return Text(label)
            .font(.caption2.bold())
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.2))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private func add() {
        _ = engine.insert("todo", ["title": .string(newTitle), "done": false])
        newTitle = ""
    }

    private func toggle(_ todo: TodoRow) {
        _ = engine.update("todo", ["id": .string(todo.id), "done": .bool(!todo.done)])
    }

    private func delete(_ todo: TodoRow) {
        _ = engine.update("todo", ["id": .string(todo.id), "isDeleted": sqliteTrue])
    }
}
