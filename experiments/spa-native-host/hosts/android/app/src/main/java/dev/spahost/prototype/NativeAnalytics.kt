package dev.spahost.prototype

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** Native-owned semantic journal. No browser content or provider SDK owns this store. */
internal data class AnalyticsConfiguration(
    val enabled: Boolean = true,
    val origin: String? = null,
    val destinations: Set<String> = setOf("recording"),
    val maxEvents: Int = 10000,
    val maxBytes: Int = 8388608,
    val retentionSeconds: Int = 604800,
) {
    companion object {
        fun parse(raw: JSONObject?, debugOrigin: String? = null): AnalyticsConfiguration {
            val obj = raw ?: JSONObject()
            NativeAnalytics.keys(obj, emptySet(), setOf("enabled", "origin", "destinations", "maxEvents", "maxBytes", "retentionSeconds"))
            val enabled = if (obj.has("enabled")) obj.opt("enabled") as? Boolean ?: throw HostError("INVALID_REQUEST", "Invalid analytics enablement") else true
            val configuredOrigin = if (!obj.has("origin") || obj.isNull("origin")) null else obj.opt("origin") as? String ?: throw HostError("INVALID_REQUEST", "Invalid analytics origin")
            val selected = if (BuildConfig.DEBUG && debugOrigin != null) HostConfiguration.normalizeOrigin(debugOrigin) else configuredOrigin?.let {
                val normalized = HostConfiguration.normalizeOrigin(it)
                if (!normalized.startsWith("https://")) throw HostError("INVALID_REQUEST", "Analytics origin must use HTTPS")
                normalized
            }
            val destinations = if (obj.has("destinations")) NativeAnalytics.tokens(obj.getJSONArray("destinations"), 8).toSet() else setOf("recording")
            return AnalyticsConfiguration(enabled, selected, destinations,
                if (obj.has("maxEvents")) NativeAnalytics.integer(obj.opt("maxEvents"), 1, 10000).toInt() else 10000,
                if (obj.has("maxBytes")) NativeAnalytics.integer(obj.opt("maxBytes"), 4096, 8388608).toInt() else 8388608,
                if (obj.has("retentionSeconds")) NativeAnalytics.integer(obj.opt("retentionSeconds"), 1, 604800).toInt() else 604800)
        }
    }
}

internal class AnalyticsPolicy private constructor(
    val raw: JSONObject, val revision: Long, val expiresAt: Long, val enabled: Boolean,
    val categories: Set<String>, val names: Set<String>, val properties: JSONObject,
    val sample: Int, val lookback: Long, val destinations: Set<String>,
) {
    val selectors: String = listOf(enabled.toString(), categories.sorted().joinToString(","), names.sorted().joinToString(","),
        properties.keys().asSequence().toList().sorted().joinToString("|") { "$it=${JSONArray().put(properties.get(it)).toString()}" },
        sample.toString(), lookback.toString(), destinations.sorted().joinToString(",")).joinToString(";")
    fun matches(event: JSONObject, now: Long): Boolean {
        val time = event.getLong("timeMs")
        if (!enabled || expiresAt <= now || time > now || now - time > lookback * 1000 || event.getString("category") !in categories || ("*" !in names && event.getString("name") !in names)) return false
        val actual = event.getJSONObject("properties")
        if (properties.keys().asSequence().any { !actual.has(it) || JSONArray().put(actual.get(it)).toString() != JSONArray().put(properties.get(it)).toString() }) return false
        return NativeAnalytics.sample(event.getString("id")) < sample
    }
    companion object {
        fun parse(raw: JSONObject, config: AnalyticsConfiguration, now: Long, allowExpired: Boolean = false): AnalyticsPolicy {
            NativeAnalytics.keys(raw, setOf("schemaVersion", "revision", "expiresAtMs", "enabled", "categories", "names", "properties", "sampleBasisPoints", "lookbackSeconds", "destinations"))
            NativeAnalytics.integer(raw.opt("schemaVersion"), 1, 1)
            val revision = NativeAnalytics.integer(raw.opt("revision"), 1, Int.MAX_VALUE.toLong())
            val expires = NativeAnalytics.integer(raw.opt("expiresAtMs"), 1, 9007199254740991L)
            if ((!allowExpired && expires <= now) || expires > now + 86400000) throw HostError("INVALID_REQUEST", "Expired or unbounded analytics policy")
            val enabled = raw.opt("enabled") as? Boolean ?: throw HostError("INVALID_REQUEST", "Invalid analytics policy enablement")
            val categories = NativeAnalytics.tokens(raw.getJSONArray("categories"), 5, empty = true).toSet()
            if (!NativeAnalytics.CATEGORIES.containsAll(categories)) throw HostError("INVALID_REQUEST", "Invalid analytics category")
            val names = NativeAnalytics.tokens(raw.getJSONArray("names"), 32, empty = true, wildcard = true).toSet()
            if (names.any { it != "*" && !NativeAnalytics.NAME.matches(it) }) throw HostError("INVALID_REQUEST", "Invalid analytics event selector")
            val props = NativeAnalytics.properties(raw.getJSONObject("properties"), 8)
            val destinations = NativeAnalytics.tokens(raw.getJSONArray("destinations"), 8, empty = true).toSet()
            if (!config.destinations.containsAll(destinations)) throw HostError("UNAUTHORIZED", "Unconfigured analytics destination")
            return AnalyticsPolicy(JSONObject(raw.toString()), revision, expires, enabled, categories, names, props,
                NativeAnalytics.integer(raw.opt("sampleBasisPoints"), 0, 10000).toInt(), NativeAnalytics.integer(raw.opt("lookbackSeconds"), 0, 604800), destinations)
        }
    }
}

/** Separate journal + network workers keep a slow collector from blocking native capture. */
internal class NativeAnalytics(
    context: Context,
    initialConfiguration: AnalyticsConfiguration,
    private val databaseFile: File = File(context.filesDir, "analytics/journal.sqlite"),
    private val clock: () -> Long = System::currentTimeMillis,
    private val transport: ((String, String, JSONObject?, Int, Long) -> JSONObject)? = null,
) {
    companion object {
        val NAME = Regex("[a-z][a-z0-9_.]{0,63}")
        private val TOKEN = Regex("[A-Za-z0-9_.:-]{1,64}")
        val CATEGORIES = setOf("lifecycle", "navigation", "bridge", "interaction", "custom")
        private val EXCLUDED = setOf("hello", "cancel", "events.subscribe", "events.unsubscribe")
        fun instrumented(action: String) = action !in EXCLUDED && !action.startsWith("analytics.")
        fun screen(path: String) = when (path.substringBefore('?')) { "/" -> "overview"; "/compose/" -> "compose"; "/library/" -> "library"; else -> if (path.startsWith("/hosted/")) "hosted" else "unknown" }
        fun keys(obj: JSONObject, required: Set<String>, optional: Set<String> = emptySet()) {
            val keys = obj.keys().asSequence().toSet()
            if (!keys.containsAll(required) || !((required + optional).containsAll(keys))) throw HostError("INVALID_REQUEST", "Invalid analytics fields")
        }
        fun integer(value: Any?, minimum: Long, maximum: Long): Long {
            val number = value as? Number ?: throw HostError("INVALID_REQUEST", "Invalid analytics number")
            val d = number.toDouble()
            if (!d.isFinite() || d != number.toLong().toDouble() || number.toLong() !in minimum..maximum) throw HostError("INVALID_REQUEST", "Invalid analytics numeric range")
            return number.toLong()
        }
        fun tokens(array: JSONArray, max: Int, empty: Boolean = false, wildcard: Boolean = false): List<String> {
            if (array.length() !in (if (empty) 0 else 1)..max) throw HostError("INVALID_REQUEST", "Invalid analytics list")
            val values = (0 until array.length()).map { array.opt(it) as? String ?: throw HostError("INVALID_REQUEST", "Invalid analytics token") }
            if (values.distinct().size != values.size || values.any { !TOKEN.matches(it) && !(wildcard && it == "*") }) throw HostError("INVALID_REQUEST", "Invalid analytics token")
            return values
        }
        fun properties(raw: JSONObject, max: Int = 12): JSONObject {
            if (raw.length() > max) throw HostError("INVALID_REQUEST", "Too many analytics properties")
            val result = JSONObject()
            raw.keys().forEach { key ->
                val value = raw.opt(key)
                val good = when (key) {
                    "screen" -> value in setOf("overview", "compose", "library", "hosted", "unknown")
                    "action", "control", "tab", "code" -> value is String && TOKEN.matches(value)
                    "kind" -> value in setOf("button", "link", "input", "select", "form", "other")
                    "outcome" -> value in setOf("ok", "error", "cancelled", "unavailable")
                    "state" -> value in setOf("started", "foreground", "background", "selected", "committed", "failed", "disposed")
                    "presentation" -> value in setOf("push", "replace", "modal", "pop", "web")
                    "durationMs" -> { integer(value, 0, 600000); true }
                    "count" -> { integer(value, 0, 1000000000); true }
                    else -> false
                }
                if (!good) throw HostError("INVALID_REQUEST", "Invalid semantic analytics property")
                result.put(key, value)
            }
            return result
        }
        fun sample(id: String): Int {
            var value = 2166136261L
            id.toByteArray(Charsets.UTF_8).forEach { value = ((value xor (it.toInt() and 255).toLong()) * 16777619L) and 0xffffffffL }
            return (value % 10000).toInt()
        }
    }
    private val main = Handler(Looper.getMainLooper())
    private val writer = ScheduledThreadPoolExecutor(1).apply { removeOnCancelPolicy = true }
    private val network = Executors.newSingleThreadExecutor()
    private val pending = AtomicInteger()
    private val admissionDrops = AtomicLong()
    private val flushing = AtomicBoolean()
    private val configurationGeneration = AtomicLong()
    @Volatile private var configuration = initialConfiguration
    @Volatile private var foreground = false
    private var db: SQLiteDatabase? = null
    private var installId = ""
    private val sessionId = UUID.randomUUID().toString()
    private var policy: AnalyticsPolicy? = null
    private var revisionFloor = 0L
    private var storedDrops = 0L
    private var nextAttempt = 0L
    private var failures = 0
    @Volatile private var uploadState = "idle"
    init {
        if (initialConfiguration.enabled) record("lifecycle", "app.started", JSONObject().put("state", "started"))
        writer.scheduleWithFixedDelay({ if (foreground && configuration.origin != null) flush() }, 30, 30, TimeUnit.SECONDS)
    }
    fun configure(config: AnalyticsConfiguration) {
        enqueue(null) {
            val changedOrigin = configuration.origin != config.origin
            if (configuration != config) configurationGeneration.incrementAndGet()
            configuration = config
            if (changedOrigin && db != null) {
                try { loadPolicy() } catch (error: Exception) {
                    // A failed reset must not leave the prior origin's cached
                    // policy usable under the newly selected configuration.
                    policy = null; revisionFloor = 0; db?.close(); db = null
                    throw error
                }
            }
            if (changedOrigin && foreground && config.origin != null) flush()
        }
    }
    fun setForeground(value: Boolean) {
        if (foreground == value) return
        foreground = value
        record("lifecycle", if (value) "app.foreground" else "app.background", JSONObject().put("state", if (value) "foreground" else "background"))
        if (value && configuration.origin != null) flush()
    }
    fun record(category: String, name: String, raw: JSONObject = JSONObject(), source: String = "native", completion: ((JSONObject?, HostError?) -> Unit)? = null) {
        try {
            if (category !in CATEGORIES || !NAME.matches(name) || source !in setOf("native", "web")) throw HostError("INVALID_REQUEST", "Invalid analytics event")
            val props = properties(raw)
            enqueue(completion) {
                if (!configuration.enabled) return@enqueue JSONObject().put("recorded", false)
                open()
                val event = JSONObject().put("schemaVersion", 1).put("id", UUID.randomUUID().toString()).put("installId", installId).put("sessionId", sessionId)
                    .put("timeMs", clock()).put("platform", "android").put("source", source).put("category", category).put("name", name).put("properties", props)
                val json = event.toString(); val bytes = json.toByteArray().size
                if (bytes > 4096) throw HostError("QUOTA_EXCEEDED", "Analytics event exceeds limit")
                database().execSQL("INSERT INTO events(id,time_ms,payload,bytes) VALUES(?,?,?,?)", arrayOf(event.getString("id"), event.getLong("timeMs"), json, bytes))
                prune()
                JSONObject().put("recorded", true)
            }
        } catch (error: HostError) { deliver(completion, null, error) }
    }
    fun status(completion: (JSONObject?, HostError?) -> Unit) { enqueue(completion) { snapshot() } }
    private fun deliver(callback: ((JSONObject?, HostError?) -> Unit)?, result: JSONObject?, error: HostError?) { if (callback != null) main.post { callback(result, error) } }
    private fun enqueue(callback: ((JSONObject?, HostError?) -> Unit)?, action: () -> Any?) {
        if (pending.incrementAndGet() > 128) { pending.decrementAndGet(); admissionDrops.incrementAndGet(); deliver(callback, null, HostError("QUOTA_EXCEEDED", "Analytics capture queue is full")); return }
        writer.execute {
            try { val result = action(); if (callback != null) deliver(callback, result as? JSONObject ?: JSONObject(), null) }
            catch (error: Exception) { admissionDrops.incrementAndGet(); deliver(callback, null, error as? HostError ?: HostError("IO_ERROR", "Analytics journal is unavailable")) }
            finally { pending.decrementAndGet() }
        }
    }
    private fun open() {
        if (db != null) return
        databaseFile.parentFile?.mkdirs()
        val opened = SQLiteDatabase.openOrCreateDatabase(databaseFile, null)
        try {
        opened.setForeignKeyConstraintsEnabled(true); opened.enableWriteAheadLogging()
        opened.execSQL("PRAGMA synchronous=FULL"); opened.rawQuery("PRAGMA journal_size_limit=1048576", null).use { it.moveToFirst() }
        opened.execSQL("CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,time_ms INTEGER NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL)")
        opened.execSQL("CREATE TABLE IF NOT EXISTS receipts(event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,destination TEXT NOT NULL,PRIMARY KEY(event_id,destination))")
        opened.execSQL("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        db = opened
        installId = meta("installId") ?: UUID.randomUUID().toString().also { meta("installId", it) }
        storedDrops = meta("drops")?.toLongOrNull() ?: 0
        loadPolicy()
        prune()
        } catch (error: Exception) { db = null; opened.close(); throw error }
    }
    private fun loadPolicy() {
        val selected = configuration.origin ?: ""
        if ((meta("origin") ?: "") == selected) {
            revisionFloor = meta("revision")?.toLongOrNull() ?: 0
            policy = meta("policy")?.takeIf { it.isNotEmpty() }?.let { runCatching { AnalyticsPolicy.parse(JSONObject(it), configuration, clock(), true) }.getOrNull() }
        } else {
            policy = null; revisionFloor = 0
            // A process starts before a Debug Activity supplies its explicit
            // collector origin. Local-only startup must not erase that origin's
            // persisted monotonic policy floor or selector cache.
            if (configuration.origin != null) {
                val connection = database()
                connection.beginTransaction()
                try {
                    meta("origin", selected); meta("revision", "0"); meta("policy", "")
                    connection.setTransactionSuccessful()
                } finally { connection.endTransaction() }
            }
        }
    }
    private fun database() = db ?: throw IOException("Analytics database not open")
    private fun meta(key: String): String? = database().rawQuery("SELECT value FROM metadata WHERE key=?", arrayOf(key)).use { if (it.moveToFirst()) it.getString(0) else null }
    private fun meta(key: String, value: String) { database().execSQL("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)", arrayOf(key, value)) }
    private fun scalar(sql: String, args: Array<String>? = null): Long = database().rawQuery(sql, args).use { it.moveToFirst(); it.getLong(0) }
    private fun prune() {
        val expired = scalar("SELECT COUNT(*) FROM events WHERE time_ms<?", arrayOf((clock() - configuration.retentionSeconds * 1000L).toString()))
        database().execSQL("DELETE FROM events WHERE time_ms<?", arrayOf(clock() - configuration.retentionSeconds * 1000L))
        storedDrops += expired
        var count = scalar("SELECT COUNT(*) FROM events"); var bytes = scalar("SELECT COALESCE(SUM(bytes),0) FROM events")
        while (count > configuration.maxEvents || bytes > configuration.maxBytes) {
            database().rawQuery("SELECT seq,bytes FROM events ORDER BY seq LIMIT 1", null).use {
                if (!it.moveToFirst()) return@use
                database().execSQL("DELETE FROM events WHERE seq=?", arrayOf(it.getLong(0))); bytes -= it.getLong(1); count--; storedDrops++
            }
        }
        meta("drops", (storedDrops + admissionDrops.get()).toString())
    }
    private fun snapshot(): JSONObject {
        if (configuration.enabled) open()
        if (db != null) prune()
        return JSONObject().put("enabled", configuration.enabled).put("configured", configuration.origin != null).put("count", if (db != null) scalar("SELECT COUNT(*) FROM events") else 0)
            .put("bytes", if (db != null) scalar("SELECT COALESCE(SUM(bytes),0) FROM events") else 0).put("dropped", storedDrops + admissionDrops.get())
            .put("acknowledged", if (db != null) scalar("SELECT COUNT(*) FROM receipts") else 0).put("policyRevision", revisionFloor)
            .put("policyExpiresAtMs", policy?.expiresAt ?: JSONObject.NULL).put("uploading", flushing.get()).put("uploadState", uploadState)
    }
    private fun <T> journal(deadline: Long = Long.MAX_VALUE, action: () -> T): T {
        val remaining = if (deadline == Long.MAX_VALUE) TimeUnit.SECONDS.toNanos(8) else (deadline - System.nanoTime()).coerceAtMost(TimeUnit.SECONDS.toNanos(8))
        if (remaining <= 0) throw IOException("Analytics deadline expired")
        val future = writer.submit<T> { action() }
        try { return future.get(remaining, TimeUnit.NANOSECONDS) }
        catch (_: java.util.concurrent.TimeoutException) { future.cancel(false); throw IOException("Analytics journal deadline expired") }
        catch (error: java.util.concurrent.ExecutionException) {
            val cause = error.cause
            if (cause is HostError) throw cause
            throw IOException("Analytics journal operation failed", cause)
        }
    }
    private fun requireBinding(config: AnalyticsConfiguration, generation: Long) {
        if (configuration != config || configurationGeneration.get() != generation) throw HostError("UNAUTHORIZED", "Analytics configuration changed during upload")
    }
    fun flush(completion: ((JSONObject?, HostError?) -> Unit)? = null) {
        if (!flushing.compareAndSet(false, true)) { deliver(completion, null, HostError("BUSY", "Analytics flush is already pending")); return }
        network.execute {
            try {
                val config = configuration
                val generation = configurationGeneration.get()
                if (!config.enabled || config.origin == null) throw HostError("UNAVAILABLE", "Analytics upload is not configured")
                val now = clock()
                if (now < nextAttempt) throw HostError("BUSY", "Analytics retry is backing off")
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25)
                journal(deadline) { requireBinding(config, generation); open() }
                val selected = try {
                    val remote = exchange("GET", config.origin + "/api/analytics/policy/", null, 65536, deadline)
                    journal(deadline) { requireBinding(config, generation); installPolicy(remote) }
                } catch (error: HostError) { throw error }
                catch (_: Exception) { journal(deadline) { requireBinding(config, generation); policy?.takeIf { it.expiresAt > clock() } } ?: throw IOException("No current analytics upload policy") }
                var accepted = 0
                if (selected.enabled) {
                    for (destination in selected.destinations.sorted()) {
                        var batches = 0
                        while (batches++ < 8 && System.nanoTime() + TimeUnit.SECONDS.toNanos(1) < deadline) {
                            val batch = journal(deadline) { requireBinding(config, generation); selectBatch(selected, destination) }
                            if (batch.length() == 0) break
                            // Recheck native enablement and cache expiry at dispatch.
                            if (!configuration.enabled || configuration != config || configurationGeneration.get() != generation || selected.expiresAt <= clock()) throw HostError("UNAUTHORIZED", "Analytics policy is no longer current")
                            val payload = JSONObject().put("schemaVersion", 1).put("destination", destination).put("policyRevision", selected.revision).put("events", batch)
                            val reply = exchange("POST", config.origin + "/api/analytics/batch/", payload, 65536, deadline)
                            val acknowledged = journal(deadline) { requireBinding(config, generation); acknowledge(destination, batch, reply) }
                            accepted += acknowledged
                            if (acknowledged < batch.length()) break
                        }
                    }
                }
                failures = 0; nextAttempt = 0; uploadState = if (!selected.enabled) "disabled" else if (accepted > 0) "collector.accepted" else "idle"
                val result = journal(deadline) { snapshot().put("accepted", accepted).put("uploading", false) }
                flushing.set(false)
                deliver(completion, result, null)
            } catch (error: Exception) {
                uploadState = "retry"
                if (error !is HostError || error.code !in setOf("BUSY", "UNAVAILABLE")) { failures = (failures + 1).coerceAtMost(8); nextAttempt = clock() + (1000L shl failures).coerceAtMost(300000L) }
                flushing.set(false)
                deliver(completion, null, error as? HostError ?: HostError("IO_ERROR", "Analytics collector is unavailable"))
            } finally { flushing.set(false) }
        }
    }
    private fun installPolicy(raw: JSONObject): AnalyticsPolicy {
        val candidate = try { AnalyticsPolicy.parse(raw, configuration, clock()) } catch (error: HostError) { throw error } catch (_: Exception) { throw HostError("INVALID_REQUEST", "Malformed analytics policy") }
        if (candidate.revision < revisionFloor || (candidate.revision == revisionFloor && policy?.selectors != candidate.selectors)) throw HostError("INVALID_REQUEST", "Stale or inconsistent analytics policy")
        database().beginTransaction()
        try { meta("revision", candidate.revision.toString()); meta("policy", candidate.raw.toString()); database().setTransactionSuccessful() } finally { database().endTransaction() }
        policy = candidate; revisionFloor = candidate.revision; return candidate
    }
    private fun selectBatch(policy: AnalyticsPolicy, destination: String): JSONArray {
        prune()
        if (policy.expiresAt <= clock()) return JSONArray()
        val batch = JSONArray(); var bytes = 256
        database().rawQuery("SELECT payload FROM events WHERE id NOT IN (SELECT event_id FROM receipts WHERE destination=?) ORDER BY seq", arrayOf(destination)).use { rows ->
            while (rows.moveToNext() && batch.length() < 100) {
                val raw = rows.getString(0); val event = JSONObject(raw)
                if (!policy.matches(event, clock())) continue
                if (bytes + raw.toByteArray().size + 1 > 256 * 1024) break
                batch.put(event); bytes += raw.toByteArray().size + 1
            }
        }
        return batch
    }
    private fun acknowledge(destination: String, batch: JSONArray, reply: JSONObject): Int {
        keys(reply, setOf("schemaVersion", "accepted")); integer(reply.opt("schemaVersion"), 1, 1)
        val requested = (0 until batch.length()).map { batch.getJSONObject(it).getString("id") }.toSet()
        val ids = reply.optJSONArray("accepted") ?: throw HostError("INVALID_REQUEST", "Malformed analytics acknowledgement")
        if (ids.length() > requested.size) throw HostError("INVALID_REQUEST", "Oversized analytics acknowledgement")
        val accepted = (0 until ids.length()).map { ids.opt(it) as? String ?: throw HostError("INVALID_REQUEST", "Invalid analytics acknowledgement") }
        if (accepted.distinct().size != accepted.size || !requested.containsAll(accepted)) throw HostError("INVALID_REQUEST", "Unrequested analytics acknowledgement")
        database().beginTransaction()
        try {
            accepted.forEach { database().execSQL("INSERT OR IGNORE INTO receipts(event_id,destination) SELECT id,? FROM events WHERE id=?", arrayOf(destination, it)) }
            database().setTransactionSuccessful()
        } finally { database().endTransaction() }
        return accepted.size
    }
    private fun exchange(method: String, url: String, payload: JSONObject?, maximum: Int, deadline: Long): JSONObject {
        transport?.let { return it(method, url, payload, maximum, deadline) }
        val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtMost(8000L)
        if (remaining < 500) throw IOException("Analytics deadline expired")
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false; connection.requestMethod = method
            connection.connectTimeout = (remaining / 2).toInt(); connection.readTimeout = (remaining / 2).toInt()
            connection.setRequestProperty("Accept", "application/json")
            if (payload != null) { val data = payload.toString().toByteArray(); if (data.size > 256 * 1024) throw IOException("Analytics batch too large"); connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json"); connection.setFixedLengthStreamingMode(data.size); connection.outputStream.use { it.write(data) } }
            if (connection.responseCode in 300..399) throw HostError("UNAUTHORIZED", "Analytics redirects are refused")
            if (connection.responseCode != 200) throw IOException("Analytics response unavailable")
            val bytes = connection.inputStream.use { input ->
                val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(4096)
                while (true) { if (System.nanoTime() >= deadline) throw IOException("Analytics deadline expired"); val length = input.read(buffer); if (length < 0) break; if (output.size() + length > maximum) throw HostError("INVALID_REQUEST", "Analytics response too large"); output.write(buffer, 0, length) }
                output.toByteArray()
            }
            val text = bytes.toString(Charsets.UTF_8)
            var depth = 0; var quoted = false; var escaped = false
            for (character in text) {
                if (quoted) { if (escaped) escaped = false else if (character == '\\') escaped = true else if (character == '"') quoted = false }
                else when (character) { '"' -> quoted = true; '{', '[' -> { depth++; if (depth > 8) throw HostError("INVALID_REQUEST", "Analytics response nesting exceeds limit") }; '}', ']' -> { depth--; if (depth < 0) throw HostError("INVALID_REQUEST", "Malformed analytics response") } }
            }
            if (quoted || depth != 0) throw HostError("INVALID_REQUEST", "Malformed analytics response")
            return try { JSONObject(text) } catch (_: Exception) { throw HostError("INVALID_REQUEST", "Malformed analytics response") }
        } finally { connection.disconnect() }
    }
    // Package-private deterministic instrumentation entry points. No bridge journal export.
    internal fun inspectForTest(): List<JSONObject> = journal { open(); database().rawQuery("SELECT payload FROM events ORDER BY seq", null).use { rows -> buildList { while (rows.moveToNext()) add(JSONObject(rows.getString(0))) } } }
    internal fun policyForTest(raw: JSONObject): AnalyticsPolicy = journal { open(); installPolicy(raw) }
    internal fun selectForTest(policy: AnalyticsPolicy, destination: String): JSONArray = journal { selectBatch(policy, destination) }
    internal fun acknowledgeForTest(destination: String, batch: JSONArray, reply: JSONObject): Int = journal { acknowledge(destination, batch, reply) }
    internal fun closeForTest() { network.shutdown(); network.awaitTermination(30, TimeUnit.SECONDS); journal { db?.close(); db = null }; writer.shutdownNow() }
}

/** Monotonic telemetry lane cannot consume ordinary business replay capacity. */
internal class AnalyticsRequestLane {
    private var lastSequence = 0L
    fun reset() { lastSequence = 0 }
    private fun sequence(document: String, id: String): Long? {
        val prefix = document + "-a"
        if (!id.startsWith(prefix)) return null
        val suffix = id.removePrefix(prefix)
        if (!Regex("[1-9][0-9]{0,15}").matches(suffix)) return null
        return suffix.toLongOrNull()?.takeIf { it in 1..9007199254740991L }
    }
    fun admit(document: String, id: String, action: String, args: JSONObject): Boolean {
        val number = sequence(document, id)
        val telemetry = action.startsWith("analytics.") || (action == "cancel" && id.startsWith(document + "-a"))
        if (!telemetry) {
            if (number != null) throw HostError("INVALID_REQUEST", "Reserved analytics identity")
            return false
        }
        if (number == null || number <= lastSequence) throw HostError("INVALID_REQUEST", "Stale analytics sequence")
        if (action == "cancel") {
            val target = sequence(document, args.optString("requestId"))
            if (target == null || target >= number) throw HostError("INVALID_REQUEST", "Invalid analytics cancellation")
        }
        lastSequence = number
        return true
    }
}
