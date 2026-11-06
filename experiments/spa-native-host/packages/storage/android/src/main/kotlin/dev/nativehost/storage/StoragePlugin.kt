package dev.nativehost.storage

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.os.Handler
import android.os.Looper
import dev.nativehost.pluginapi.NativePlugin
import dev.nativehost.pluginapi.PluginAction
import dev.nativehost.pluginapi.PluginCallContext
import dev.nativehost.pluginapi.PluginEnvironment
import dev.nativehost.pluginapi.PluginFailure
import org.json.JSONObject
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

/** The process owns one queue/database, independently of documents or activities. */
class StoragePlugin(environment: PluginEnvironment) : NativePlugin {
    override val id = "storage"
    override val actions = listOf(PluginAction("storage.get"), PluginAction("storage.set"), PluginAction("storage.remove"))
    override val events = emptySet<String>()
    private val main = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private val database = StorageDatabase(environment.applicationContext)
    private val admission = Any()
    private var accepted = 0

    override fun invoke(context: PluginCallContext, action: String, args: JSONObject, completion: (Any?, PluginFailure?) -> Unit) {
        if (actions.none { it.name == action }) throw PluginFailure("UNSUPPORTED", "Storage action is not installed")
        val fields = if (action == "storage.set") setOf("key", "value") else setOf("key")
        if (args.keys().asSequence().toSet() != fields) throw PluginFailure("INVALID_REQUEST", "Unexpected storage arguments")
        val key = args.opt("key") as? String ?: throw PluginFailure("INVALID_REQUEST", "Storage key must be a string")
        utf8Length(key, 128, false)
        val value = if (action == "storage.set") args.opt("value") as? String ?: throw PluginFailure("INVALID_REQUEST", "Storage value must be a string") else null
        if (value != null) utf8Length(value, 32768, true)
        synchronized(admission) {
            if (accepted >= 64) throw PluginFailure("QUOTA_EXCEEDED", "Storage operation capacity exceeded")
            accepted++
        }
        try {
            executor.execute {
                val outcome = runCatching<Any?> {
                    when (action) {
                        "storage.get" -> database.get(key)
                        "storage.set" -> { database.set(key, value!!); null }
                        else -> { database.remove(key); null }
                    }
                }
                main.post {
                    // Capacity belongs to accepted physical work. Cancellation,
                    // navigation and activity destruction never release it early.
                    synchronized(admission) { accepted-- }
                    outcome.fold({ completion(it, null) }, { completion(null, it as? PluginFailure ?: PluginFailure("IO_ERROR", "Storage operation failed")) })
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            synchronized(admission) { accepted-- }
            throw PluginFailure("UNAVAILABLE", "Storage service is unavailable")
        }
    }
    // Accepted writes may commit after their caller goes away. The host's
    // document/request identity suppresses delivery, while this queue drains.
    override fun cancel(owner: String, requestId: String?) = Unit

    companion object {
        internal fun utf8Length(value: String, maximum: Int, empty: Boolean): Int {
            if ((!empty && value.isEmpty()) || value.length > maximum) throw PluginFailure("INVALID_REQUEST", "Storage string exceeds its byte limit")
            return try {
                val encoder = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                val length = encoder.encode(CharBuffer.wrap(value)).remaining()
                if (length > maximum) throw PluginFailure("INVALID_REQUEST", "Storage string exceeds its byte limit")
                length
            } catch (failure: java.nio.charset.CharacterCodingException) { throw PluginFailure("INVALID_REQUEST", "Storage requires valid UTF-8 strings") }
        }
    }
}

/** Exactly the pre-package database path and schema; no migration or copying. */
private class StorageDatabase(context: Context) : SQLiteOpenHelper(context, "platform.sqlite", null, 1) {
    override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)") }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) = Unit
    override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL") }
    fun get(key: String): String? = readableDatabase.rawQuery("SELECT value FROM kv WHERE key=?", arrayOf(key)).use { if (it.moveToFirst()) it.getString(0) else null }
    fun set(key: String, value: String) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val size = db.rawQuery("SELECT COALESCE(SUM(length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))),0) FROM kv WHERE key <> ?", arrayOf(key)).use { it.moveToFirst(); it.getLong(0) }
            if (size + key.toByteArray(StandardCharsets.UTF_8).size + value.toByteArray(StandardCharsets.UTF_8).size > 1024 * 1024) throw PluginFailure("QUOTA_EXCEEDED", "Storage quota exceeded")
            if (db.insertWithOnConflict("kv", null, ContentValues().apply { put("key", key); put("value", value) }, SQLiteDatabase.CONFLICT_REPLACE) < 0) throw PluginFailure("IO_ERROR", "Storage write failed")
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    fun remove(key: String) { writableDatabase.delete("kv", "key=?", arrayOf(key)) }
}
