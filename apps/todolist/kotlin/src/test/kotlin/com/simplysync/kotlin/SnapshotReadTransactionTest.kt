package com.simplysync.kotlin

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

/** The native snapshot consumer can reuse the existing driver transaction contract. */
class SnapshotReadTransactionTest {
    @Test fun readTransactionKeepsTablesAndCursorAtOneVersionWhileAnotherConnectionCommits() {
        val folder = Files.createTempDirectory("simplysync-read-snapshot-").toFile()
        val path = folder.resolve("wallet.sqlite").path
        val reader = JdbcSqliteDriver(path)
        reader.exec("PRAGMA journal_mode=WAL")
        reader.exec("CREATE TABLE firstValue (value TEXT)")
        reader.exec("CREATE TABLE secondValue (value TEXT)")
        reader.exec("CREATE TABLE cursorValue (value TEXT)")
        for (table in listOf("firstValue", "secondValue", "cursorValue")) {
            reader.exec("INSERT INTO $table(value) VALUES ('1')")
        }
        val writer = JdbcSqliteDriver(path)
        try {
            val snapshot = reader.transaction {
                val first = reader.select("SELECT value FROM firstValue").single().getValue("value")
                writer.transaction {
                    for (table in listOf("firstValue", "secondValue", "cursorValue")) {
                        writer.exec("UPDATE $table SET value = '2'")
                    }
                }
                listOf(first,
                    reader.select("SELECT value FROM secondValue").single().getValue("value"),
                    reader.select("SELECT value FROM cursorValue").single().getValue("value"))
            }
            assertEquals(List(3) { SqliteValue.Text("1") }, snapshot)
            assertEquals(SqliteValue.Text("2"), writer.select("SELECT value FROM firstValue").single()["value"])
        } finally {
            writer.close()
            reader.close()
            folder.deleteRecursively()
        }
    }
}
