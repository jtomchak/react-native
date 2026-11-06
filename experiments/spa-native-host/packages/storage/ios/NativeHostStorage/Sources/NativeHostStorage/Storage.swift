import Foundation
import SQLite3
import NativeHostPluginAPI

final class Storage {
    private let queue = DispatchQueue(label: "dev.spahost.storage")
    private var db: OpaquePointer?
    private var outstanding = 0
    private let root: URL
    init(root: URL) { self.root = root }
    deinit { if let db { sqlite3_close(db) } }
    #if DEBUG
    func holdWriterForTesting(entered: @escaping () -> Void, until gate: DispatchSemaphore) { queue.async { DispatchQueue.main.async(execute: entered); gate.wait() } }
    #endif
    private func open() throws {
        if db != nil { return }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var connection: OpaquePointer?
        guard sqlite3_open(root.appendingPathComponent("storage.sqlite").path, &connection) == SQLITE_OK else {
            if let connection { sqlite3_close(connection) }
            throw PluginFailure("IO_ERROR", "Storage is unavailable")
        }
        db = connection
        try exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    }
    private func exec(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw PluginFailure("IO_ERROR", "Storage transaction failed") }
    }
    private func statement(_ sql: String, _ args: [String]) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw PluginFailure("IO_ERROR", "Storage operation failed") }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in args.enumerated() {
            guard let byteCount = Int32(exactly: value.utf8.count) else { sqlite3_finalize(stmt); throw PluginFailure("INVALID_REQUEST", "Storage input is too large") }
            let status = value.withCString { sqlite3_bind_text(stmt, Int32(index + 1), $0, byteCount, transient) }
            guard status == SQLITE_OK else { sqlite3_finalize(stmt); throw PluginFailure("IO_ERROR", "Storage input failed") }
        }
        return stmt
    }
    private func read(_ key: String) throws -> String? {
        let stmt = try statement("SELECT value FROM kv WHERE key=?", [key]); defer { sqlite3_finalize(stmt) }
        let result = sqlite3_step(stmt)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW, let bytes = sqlite3_column_text(stmt, 0) else { throw PluginFailure("IO_ERROR", "Storage read failed") }
        let count = Int(sqlite3_column_bytes(stmt, 0))
        guard let value = String(bytes: UnsafeBufferPointer(start: bytes, count: count), encoding: .utf8) else { throw PluginFailure("IO_ERROR", "Storage text is invalid") }
        return value
    }
    func perform(action: String, key: String, value: String?, completion: @escaping (Result<Any, PluginFailure>) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        // Cancellation ends delivery, not necessarily accepted disk work. Keep
        // this bound independent of the host's live-promise registry.
        guard outstanding < 64 else { completion(.failure(PluginFailure("BUSY", "Storage queue is full"))); return }
        outstanding += 1
        queue.async {
            let result: Result<Any, PluginFailure>
            do {
                try self.open()
                switch action {
                case "storage.get": result = .success(try self.read(key) as Any? ?? NSNull())
                case "storage.set", "storage.remove":
                    try self.exec("BEGIN IMMEDIATE")
                    do {
                        let stmt = try self.statement(action == "storage.set" ? "INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)" : "DELETE FROM kv WHERE key=?", action == "storage.set" ? [key, value!] : [key])
                        defer { sqlite3_finalize(stmt) }
                        guard sqlite3_step(stmt) == SQLITE_DONE else { throw PluginFailure("IO_ERROR", "Storage write failed") }
                        let count = try self.statement("SELECT COALESCE(SUM(length(CAST(key AS BLOB))+length(CAST(value AS BLOB))),0) FROM kv", [])
                        defer { sqlite3_finalize(count) }
                        guard sqlite3_step(count) == SQLITE_ROW else { throw PluginFailure("IO_ERROR", "Storage quota read failed") }
                        guard sqlite3_column_int64(count, 0) <= 1_048_576 else { throw PluginFailure("QUOTA_EXCEEDED", "Storage quota exceeded") }
                        try self.exec("COMMIT")
                        result = .success(NSNull())
                    } catch { try? self.exec("ROLLBACK"); throw error }
                default: throw PluginFailure("UNSUPPORTED", "Unknown storage action")
                }
            } catch let error as PluginFailure { result = .failure(error) }
            catch { result = .failure(PluginFailure("IO_ERROR", "Storage failed")) }
            DispatchQueue.main.async { self.outstanding -= 1; completion(result) }
        }
    }
}
