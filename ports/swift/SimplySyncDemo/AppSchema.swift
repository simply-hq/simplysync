import Foundation

/// The demo's schema — one `todo` table. The engine derives the physical table
/// and adds the system columns (`createdAt`, `updatedAt`, `isDeleted`) itself.
let appSchema = Schema([
    "todo": [
        "id": .id("todo"),
        "title": .nonEmptyString,
        "done": .sqliteBoolean,
    ],
])

/// One row of the demo's todo list, decoded from a query.
struct TodoRow: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let done: Bool
}

/// Live, ordered, non-deleted todos. The table name is double-quoted so the
/// query cache knows a write to `todo` should refresh it.
let todosQuery = Query<TodoRow>(
    "select id, title, done from \"todo\" where \"isDeleted\" = 0 order by \"updatedAt\" desc")
