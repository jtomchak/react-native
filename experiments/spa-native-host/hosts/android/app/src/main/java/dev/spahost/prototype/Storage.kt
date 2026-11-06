package dev.spahost.prototype

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** One private namespace, serialized by the host executor. No page-supplied paths. */
internal class Storage(context: Context) : SQLiteOpenHelper(context, "platform.sqlite", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) = Unit
    override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL") }
    fun get(key: String): String? = readableDatabase.rawQuery("SELECT value FROM kv WHERE key=?", arrayOf(key)).use {
        if (it.moveToFirst()) it.getString(0) else null
    }
    fun set(key: String, value: String) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val size = db.rawQuery("SELECT COALESCE(SUM(length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))),0) FROM kv WHERE key <> ?", arrayOf(key)).use { it.moveToFirst(); it.getLong(0) }
            if (size + key.toByteArray().size + value.toByteArray().size > 1024 * 1024) throw HostError("QUOTA_EXCEEDED", "Storage quota exceeded")
            db.insertWithOnConflict("kv", null, ContentValues().apply { put("key", key); put("value", value) }, SQLiteDatabase.CONFLICT_REPLACE).also {
                if (it < 0) throw HostError("IO_ERROR", "Storage write failed")
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    fun remove(key: String) { writableDatabase.delete("kv", "key=?", arrayOf(key)) }
}

internal class HostError(val code: String, message: String) : Exception(message)
