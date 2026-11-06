package dev.spahost.prototype

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** Native journal/selector/receipt assertions; web transport checks are separately labelled. */
internal class AnalyticsSuite(private val runner: Instrumentation, private val arguments: Bundle) {
    private var assertions = 0
    private val engines = mutableListOf<NativeAnalytics>()
    private val now = AtomicLong(System.currentTimeMillis())
    private lateinit var directory: File
    private var host: HostActivity? = null
    private fun check(name: String, value: Boolean) { if (!value) throw AssertionError(name); assertions++; runner.sendStatus(0, Bundle().apply { putString("assertion", name) }) }
    private fun rejected(name: String, action: () -> Unit) { var failed = false; try { action() } catch (_: Exception) { failed = true }; check(name, failed) }
    private fun engine(name: String, config: AnalyticsConfiguration = AnalyticsConfiguration(), transport: ((String, String, JSONObject?, Int, Long) -> JSONObject)? = null): NativeAnalytics =
        NativeAnalytics(runner.targetContext, config, File(directory, "$name.sqlite"), now::get, transport).also { engines.add(it) }
    private fun waitCallback(operation: (((JSONObject?, HostError?) -> Unit)) -> Unit): Pair<JSONObject?, HostError?> {
        val latch = CountDownLatch(1); var result: JSONObject? = null; var error: HostError? = null
        operation { value, failure -> result = value; error = failure; latch.countDown() }
        if (!latch.await(28, TimeUnit.SECONDS)) throw AssertionError("Native analytics callback timed out")
        return result to error
    }
    private fun record(engine: NativeAnalytics, name: String, props: JSONObject = JSONObject()): JSONObject {
        val result = waitCallback { engine.record("custom", name, props, "web", it) }
        if (result.second != null) throw AssertionError(result.second!!.message)
        return result.first!!
    }
    private fun policy(revision: Int, names: List<String> = listOf("*"), properties: JSONObject = JSONObject(), destinations: List<String> = listOf("recording")): JSONObject = JSONObject()
        .put("schemaVersion", 1).put("revision", revision).put("expiresAtMs", now.get() + 300000).put("enabled", true)
        .put("categories", JSONArray(listOf("lifecycle", "navigation", "bridge", "interaction", "custom"))).put("names", JSONArray(names))
        .put("properties", properties).put("sampleBasisPoints", 10000).put("lookbackSeconds", 604800).put("destinations", JSONArray(destinations))
    fun run() {
        val report = Bundle()
        try {
            directory = File(runner.targetContext.cacheDir, "analytics-test-${UUID.randomUUID()}").apply { mkdirs() }
            if (arguments.getString("phase") != null) live(arguments.getString("phase")!!) else {
                core()
                if (arguments.getString("coreOnly") != "true") bridge()
            }
            report.putString("status", "passed"); report.putInt("assertions", assertions); report.putInt("pid", android.os.Process.myPid())
            report.putString("limits", "Native journal and semantic transport; collector HTTP and vendor delivery require separate receipts")
            runner.finish(Activity.RESULT_OK, report)
        } catch (error: Throwable) {
            report.putString("status", "failed"); report.putInt("assertions", assertions); report.putString("error", error.toString()); report.putString("stack", error.stackTraceToString())
            runner.finish(1, report)
        } finally {
            host?.let { current -> runner.runOnMainSync { current.finish() } }
            engines.forEach { runCatching { it.closeForTest() } }
            if (::directory.isInitialized) directory.deleteRecursively()
        }
    }
    private fun core() {
        check("analytics defaults are local only", AnalyticsConfiguration.parse(null).origin == null)
        rejected("remote collection cannot accept arbitrary property fields") { NativeAnalytics.properties(JSONObject().put("password", "do-not-store")) }
        rejected("remote policy cannot select an unknown destination") { AnalyticsPolicy.parse(policy(1, destinations = listOf("foreign")), AnalyticsConfiguration(), now.get()) }
        rejected("bundled analytics origin forbids HTTP", { AnalyticsConfiguration.parse(JSONObject().put("origin", "http://127.0.0.1:18797")) })
        val lane = AnalyticsRequestLane()
        for (sequence in 1..4200) lane.admit("document", "document-a$sequence", "analytics.observe", JSONObject())
        check("4200 semantic requests bypass ordinary seen capacity", !lane.admit("document", "business-request", "storage.get", JSONObject()))
        rejected("telemetry replay is rejected") { lane.admit("document", "document-a4200", "analytics.observe", JSONObject()) }
        rejected("telemetry cannot cancel ordinary business work") { lane.admit("document", "document-a4201", "cancel", JSONObject().put("requestId", "business-request")) }
        check("telemetry cancellation has its own sequence", lane.admit("document", "document-a4202", "cancel", JSONObject().put("requestId", "document-a4200")))
        rejected("ordinary work cannot use reserved telemetry identity") { lane.admit("document", "document-a5000", "storage.set", JSONObject()) }
        lane.reset(); check("document invalidation resets its telemetry lane", lane.admit("document", "document-a1", "analytics.status", JSONObject()))
        check("sampling agrees with fixed FNV1a vector", NativeAnalytics.sample("hello") == 1723 && NativeAnalytics.sample("00000000-0000-4000-8000-000000000001") == 9522 && NativeAnalytics.sample("00000000-0000-4000-8000-000000000002") == 1903)
        check("route bucketing strips dynamic/query data", NativeAnalytics.screen("/hosted/item/private-identifier/?token=secret") == "hosted")
        check("analytics bridge calls do not recursively instrument", !NativeAnalytics.instrumented("analytics.observe") && !NativeAnalytics.instrumented("events.subscribe"))
        val first = engine("durable", AnalyticsConfiguration(destinations = setOf("recording", "secondary")))
        first.inspectForTest() // Surface native database initialization errors in the test report.
        record(first, "custom.keep", JSONObject().put("control", "safe-button").put("count", 2))
        record(first, "custom.later", JSONObject().put("kind", "button"))
        val events = first.inspectForTest()
        val kept = events.first { it.getString("name") == "custom.keep" }
        check("native stamps canonical platform and source", kept.getString("platform") == "android" && kept.getString("source") == "web")
        check("native owns event installation and session UUIDs", listOf("id", "installId", "sessionId").all { UUID.fromString(kept.getString(it)).toString() == kept.getString(it) })
        check("stored event has no raw value, label or query fields", !kept.toString().contains("secret") && kept.getJSONObject("properties").length() == 2)
        val invalid = waitCallback { first.record("custom", "custom.rejected", JSONObject().put("value", "secret-input"), "web", it) }
        check("manual sensitive properties fail before admission", invalid.second?.code == "INVALID_REQUEST" && first.inspectForTest().none { it.getString("name") == "custom.rejected" })
        val p1 = first.policyForTest(policy(1, listOf("custom.keep")))
        val batch1 = first.selectForTest(p1, "recording")
        check("initial remote selector excludes retained history", batch1.length() == 1 && batch1.getJSONObject(0).getString("id") == kept.getString("id"))
        rejected("unknown ACK cannot discard queued events") { first.acknowledgeForTest("recording", batch1, JSONObject().put("schemaVersion", 1).put("accepted", JSONArray().put(UUID.randomUUID().toString()))) }
        check("rejected ACK leaves event selectable", first.selectForTest(p1, "recording").length() == 1)
        check("successful destination ACK commits exactly requested ID", first.acknowledgeForTest("recording", batch1, JSONObject().put("schemaVersion", 1).put("accepted", JSONArray().put(kept.getString("id")))) == 1)
        check("ACK does not remove local history", first.inspectForTest().any { it.getString("id") == kept.getString("id") })
        check("already acknowledged event not selected again", first.selectForTest(p1, "recording").length() == 0)
        val p2 = first.policyForTest(policy(2, listOf("custom.keep", "custom.later"), destinations = listOf("recording", "secondary")))
        val later = first.selectForTest(p2, "recording")
        check("new filter selects retained previously excluded event", later.length() == 1 && later.getJSONObject(0).getString("name") == "custom.later")
        check("new destination can select acknowledged retained history", first.selectForTest(p2, "secondary").length() == 2)
        rejected("lower revision cannot resurrect previous upload policy") { first.policyForTest(policy(1)) }
        rejected("same revision cannot silently change selectors") { first.policyForTest(policy(2, listOf("custom.keep"))) }
        val originalInstall = kept.getString("installId"); val originalSession = kept.getString("sessionId")
        first.closeForTest(); engines.remove(first)
        val restored = engine("durable", AnalyticsConfiguration(destinations = setOf("recording", "secondary")))
        val recovered = restored.inspectForTest()
        check("event survives journal close/reopen", recovered.any { it.getString("id") == kept.getString("id") })
        check("installation identity persists while process session changes", recovered.last().getString("installId") == originalInstall && recovered.last().getString("sessionId") != originalSession)
        val restoredPolicy = restored.policyForTest(policy(2, listOf("custom.keep", "custom.later"), destinations = listOf("recording", "secondary")))
        check("destination receipts survive journal reopen", restored.selectForTest(restoredPolicy, "recording").length() == 1)
        now.addAndGet(300001)
        check("expired policy selects nothing", restored.selectForTest(restoredPolicy, "secondary").length() == 0)
        rejected("expired fetched policy rejected", { restored.policyForTest(policy(3).put("expiresAtMs", now.get() - 1)) })
        val bounded = engine("bounded", AnalyticsConfiguration(maxEvents = 3, retentionSeconds = 1))
        for (index in 0..5) record(bounded, "custom.bounded", JSONObject().put("count", index))
        val boundedEvents = bounded.inspectForTest()
        check("native count bound evicts oldest events", boundedEvents.size == 3 && boundedEvents.first().getJSONObject("properties").getInt("count") == 3)
        now.addAndGet(2000)
        val boundedStatus = waitCallback { bounded.status(it) }.first!!
        check("TTL evicts data independently of export selectors", boundedStatus.getInt("count") == 0 && boundedStatus.getLong("dropped") >= 7)
        val sends = AtomicInteger(); val received = mutableListOf<String>(); var currentPolicy = policy(1, listOf("custom.upload"))
        val upload = engine("upload", AnalyticsConfiguration(origin = "https://collector.example.test")) { method, _, payload, _, _ ->
            if (method == "GET") JSONObject(currentPolicy.toString()) else {
                sends.incrementAndGet(); val batch = payload!!.getJSONArray("events"); val accepted = JSONArray()
                for (i in 0 until batch.length()) { val id = batch.getJSONObject(i).getString("id"); received.add(id); accepted.put(id) }
                JSONObject().put("schemaVersion", 1).put("accepted", accepted)
            }
        }
        record(upload, "custom.upload")
        val flushed = waitCallback { upload.flush(it) }
        check("single-flight transport ACK reaches native receipt", flushed.second == null && flushed.first?.getInt("accepted") == 1)
        waitCallback { upload.flush(it) }
        check("repeated flush does not resend destination ACK", sends.get() == 1 && received.distinct().size == 1)
        currentPolicy = policy(2, listOf("custom.upload", "custom.future")); record(upload, "custom.future")
        check("next remote policy revision applied without binary change", waitCallback { upload.flush(it) }.first?.getLong("policyRevision") == 2L)
        check("future event uploads under changed filters", sends.get() == 2 && received.distinct().size == 2)
        val getStarted = CountDownLatch(1); val releaseGet = CountDownLatch(1); val postsToB = AtomicInteger()
        val configA = AnalyticsConfiguration(origin = "https://a.example.test")
        val configB = AnalyticsConfiguration(origin = "https://b.example.test")
        val rebinding = engine("rebinding", configA) { method, url, _, _, _ ->
            if (url.startsWith(configA.origin!!)) { getStarted.countDown(); if (!releaseGet.await(8, TimeUnit.SECONDS)) throw java.io.IOException("Test GET hold timed out"); policy(1) }
            else { if (method == "POST") postsToB.incrementAndGet(); throw java.io.IOException("B is offline") }
        }
        record(rebinding, "custom.rebinding")
        val firstFlush = CountDownLatch(1); var firstFailure: HostError? = null
        rebinding.flush { _, error -> firstFailure = error; firstFlush.countDown() }
        check("rebind race holds actual GET A", getStarted.await(5, TimeUnit.SECONDS))
        rebinding.configure(configB); rebinding.inspectForTest(); releaseGet.countDown()
        check("origin A response rejected after configuration B commits", firstFlush.await(10, TimeUnit.SECONDS) && firstFailure?.code == "UNAUTHORIZED")
        now.addAndGet(3000)
        check("offline B cannot reuse origin A policy", waitCallback { rebinding.flush(it) }.second != null && postsToB.get() == 0)
        // Abort the second metadata write using SQLite's own trigger mechanism.
        // No runtime fault-injection method is added to the production engine.
        val atomicConfigA = AnalyticsConfiguration(origin = "https://atomic-a.example.test")
        val atomicConfigB = AnalyticsConfiguration(origin = "https://atomic-b.example.test")
        val atomic = engine("atomic-binding", atomicConfigA)
        record(atomic, "custom.atomic_binding")
        val policyA = atomic.policyForTest(policy(7))
        atomic.closeForTest(); engines.remove(atomic)
        val file = File(directory, "atomic-binding.sqlite")
        android.database.sqlite.SQLiteDatabase.openDatabase(file.path, null, android.database.sqlite.SQLiteDatabase.OPEN_READWRITE).use { db ->
            db.execSQL("CREATE TRIGGER fail_policy_reset BEFORE INSERT ON metadata WHEN NEW.key='revision' AND NEW.value='0' BEGIN SELECT RAISE(ABORT,'test reset failure'); END")
        }
        val interrupted = engine("atomic-binding", atomicConfigB)
        rejected("SQLite fault aborts origin rebind before commit") { interrupted.inspectForTest() }
        interrupted.closeForTest(); engines.remove(interrupted)
        android.database.sqlite.SQLiteDatabase.openDatabase(file.path, null, android.database.sqlite.SQLiteDatabase.OPEN_READWRITE).use { db ->
            fun value(key: String): String? = db.rawQuery("SELECT value FROM metadata WHERE key=?", arrayOf(key)).use { if (it.moveToFirst()) it.getString(0) else null }
            check("failed rebind rolls origin revision and policy back together", value("origin") == atomicConfigA.origin && value("revision") == "7" && value("policy") == policyA.raw.toString())
            db.execSQL("DROP TRIGGER fail_policy_reset")
        }
        val afterRollback = engine("atomic-binding", atomicConfigA)
        afterRollback.inspectForTest()
        rejected("rollback preserves origin A monotonic revision across reopen") { afterRollback.policyForTest(policy(6)) }
        check("rollback recovery can install a newer valid policy", afterRollback.policyForTest(policy(8)).revision == 8L)
    }
    private fun live(phase: String) {
        host = runner.startActivitySync(Intent(runner.targetContext, HostActivity::class.java).setData(android.net.Uri.parse("spahost://app/"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK).putExtra("spa.navigation", "native").putExtra("spa.chrome", "tabs")
            .putExtra("spa.analytics.origin", "http://127.0.0.1:18797")) as HostActivity
        runner.runOnMainSync { host!!.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(40)
        while (System.nanoTime() < deadline && js("typeof platform==='object' && document.readyState==='complete'") != true) Thread.sleep(100)
        if (phase == "record") {
            check("live keep event committed", (action("return await platform.call('analytics.track',{name:'custom.analytics_keep',properties:{control:'android-live'}})") as? JSONObject)?.optBoolean("recorded") == true)
            check("live later event committed", (action("return await platform.call('analytics.track',{name:'custom.analytics_later',properties:{control:'android-live'}})") as? JSONObject)?.optBoolean("recorded") == true)
        }
        var result: JSONObject? = null
        val flushDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < flushDeadline && result == null) {
            val raw = action("try{return await platform.call('analytics.flush',{})}catch(e){return {failure:e.code}}") as? JSONObject
            if (raw?.optString("failure") == "BUSY") Thread.sleep(500) else result = raw
        }
        check("real HTTP collector flush returns success", result != null && !result!!.has("failure"))
        check("real HTTP policy revision applied", result!!.getLong("policyRevision") == (arguments.getString("revision")?.toLongOrNull() ?: if (phase == "record") 1L else 2L))
        val all = (runner.targetContext.applicationContext as HostApplication).analytics.inspectForTest()
        check("both events retained natively after filtered upload", all.any { it.getString("name") == "custom.analytics_keep" } && all.any { it.getString("name") == "custom.analytics_later" })
        check("native collector receipt exists", result!!.getInt("acknowledged") >= if (phase == "record") 1 else 2)
        runner.sendStatus(0, Bundle().apply { putString("liveResult", result.toString()) })
    }
    private fun bridge() {
        host = runner.startActivitySync(Intent(runner.targetContext, HostActivity::class.java).setData(android.net.Uri.parse("spahost://app/"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK).putExtra("spa.navigation", "native").putExtra("spa.chrome", "tabs")) as HostActivity
        runner.runOnMainSync { host!!.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(40)
        while (System.nanoTime() < deadline && js("typeof platform==='object' && document.readyState==='complete'") != true) Thread.sleep(100)
        check("actual document SDK analytics capability", action("return (await platform.ready()).capabilities.includes('analytics.track')") == true)
        check("native semantic custom track commits", (action("return await platform.call('analytics.track',{name:'custom.android_probe',properties:{control:'native-test',count:1}})") as? JSONObject)?.optBoolean("recorded") == true)
        check("web cannot impersonate lifecycle event", action("try{await platform.call('analytics.track',{name:'app.started'});return 'bad'}catch(e){return e.code}") == "INVALID_REQUEST")
        check("web cannot submit raw input values", action("try{await platform.call('analytics.track',{name:'custom.private',properties:{value:'private-input'}});return 'bad'}catch(e){return e.code}") == "INVALID_REQUEST")
        check("aggregate status excludes raw journal identity", (action("return await platform.call('analytics.status',{})") as? JSONObject)?.let { it.optBoolean("enabled") && !it.has("installId") && !it.has("eventsData") } == true)
        val appAnalytics = (runner.targetContext.applicationContext as HostApplication).analytics
        val before = appAnalytics.inspectForTest().count { it.getString("category") == "bridge" }
        action("return await platform.call('analytics.status',{})")
        val after = appAnalytics.inspectForTest().count { it.getString("category") == "bridge" }
        check("analytics status does not recursively log bridge events", before == after)
        check("ordinary storage still operates with telemetry lane", action("await platform.storage.set('analytics-business-proof','actual-value');return await platform.storage.get('analytics-business-proof')") == "actual-value")
        val stored = appAnalytics.inspectForTest()
        check("bridge journal excludes storage values and keys", stored.none { it.toString().contains("actual-value") || it.toString().contains("analytics-business-proof") || it.toString().contains("private-input") })
    }
    private fun js(source: String): Any? {
        val latch = CountDownLatch(1); var result: String? = null
        runner.runOnMainSync { host!!.webView.evaluateJavascript(source) { result = it; latch.countDown() } }
        if (!latch.await(5, TimeUnit.SECONDS)) throw AssertionError("WebView evaluation timeout")
        return result?.let { JSONTokener(it).nextValue().let { value -> if (value === JSONObject.NULL) null else value } }
    }
    private fun action(body: String): Any? {
        js("window.__analyticsTest=null;(async()=>{$body})().then(value=>__analyticsTest={ok:true,value},error=>__analyticsTest={ok:false,error:String(error)});true")
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            val raw = js("JSON.stringify(window.__analyticsTest)") as? String
            if (raw != null && raw != "null") { val obj = JSONObject(raw); if (!obj.getBoolean("ok")) throw AssertionError(obj.getString("error")); return obj.opt("value").let { if (it === JSONObject.NULL) null else it } }
            Thread.sleep(50)
        }
        throw AssertionError("Analytics SDK timeout")
    }
}
