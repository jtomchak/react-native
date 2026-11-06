package dev.spahost.prototype

import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Generic native host runner. Optional suites come only from selected packages. */
class HostInstrumentation : Instrumentation() {
    private lateinit var host: HostActivity
    private var assertions = 0
    private var arguments = Bundle()
    override fun onCreate(arguments: Bundle?) { this.arguments = arguments ?: Bundle(); super.onCreate(arguments); start() }
    override fun onStart() {
        val mode = arguments.getString("mode")
        GeneratedPluginTestRegistry.modes[mode]?.let { entry ->
            try {
                val type = Class.forName(entry)
                val suite = type.getDeclaredConstructor(HostInstrumentation::class.java, Bundle::class.java).apply { isAccessible = true }.newInstance(this, arguments)
                type.getDeclaredMethod("run").apply { isAccessible = true }.invoke(suite)
            } catch (error: Throwable) { finish(1, Bundle().apply { putString("status", "failed"); putString("error", error.toString()) }) }
            return
        }
        if (mode == "analytics") { AnalyticsSuite(this, arguments).run(); return }
        if (mode == "extensions") { ExtensionSuite(this, arguments).run(); return }
        if (mode != null && mode != "plugins") { finish(1, Bundle().apply { putString("status", "unsupported"); putString("error", "Requested integration suite is not installed") }); return }
        val report = Bundle()
        try {
            host = startActivitySync(Intent(targetContext, HostActivity::class.java).setData(android.net.Uri.parse("spahost://app/")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as HostActivity
            runOnMainSync { host.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            waitFor("native document", 40) { host.browserReady }
            waitFor("injected SDK", 40) { js("typeof platform==='object'&&document.readyState==='complete'") == true }
            check("real transport handshake", action("return(await platform.ready()).platform") == "android")
            check("generic plugin identifiers permit underscores", PluginRuntime.validIdentifier("secure_storage.status") && PluginRuntime.validIdentifier("secure_storage.changed"))
            val runtime = (targetContext.applicationContext as HostApplication).plugins
            val expected = arguments.getString("expectedPlugins")?.toIntOrNull() ?: runtime.instances.size
            check("generated selection matches actual native factories", runtime.instances.size == expected)
            check("selected package actions advertised", action("const names=(await platform.ready()).capabilities;return ${org.json.JSONArray(runtime.actions.keys)}.every(name=>names.includes(name))") == true)
            arguments.getString("absentAction")?.let { name ->
                check("removed action not advertised", action("return!(await platform.ready()).capabilities.includes(${JSONObject.quote(name)})") == true)
                check("removed action rejected by native dispatcher", action("try{await platform.call(${JSONObject.quote(name)},{});return'bad'}catch(e){return e.code}") == "UNSUPPORTED")
            }
            arguments.getString("absentPrefix")?.let { prefix -> check("removed namespace has no native capabilities", action("return!(await platform.ready()).capabilities.some(name=>name.startsWith(${JSONObject.quote(prefix)}))") == true) }
            arguments.getString("absentNamespace")?.let { name -> check("removed SDK namespace is absent", js("typeof platform[${JSONObject.quote(name)}]==='undefined'") == true) }
            arguments.getString("smokeAction")?.let { name -> check("remaining package service still responds", action("return(await platform.call(${JSONObject.quote(name)},{}))!==undefined") == true) }
            check("core native chrome works independently of optional packages", action("return(await platform.call('chrome.state',{})).apiVersion") == 2)
            check("native analytics remains independent", action("return typeof(await platform.call('analytics.status',{}))==='object'") == true)
            report.putString("status", "passed"); report.putInt("assertions", assertions); report.putInt("plugins", runtime.instances.size)
            runOnMainSync { host.finish() }; finish(android.app.Activity.RESULT_OK, report)
        } catch (error: Throwable) {
            report.putString("status", "failed"); report.putInt("assertions", assertions); report.putString("error", error.toString()); report.putString("stack", error.stackTraceToString())
            if (::host.isInitialized) runOnMainSync { host.finish() }
            finish(1, report)
        }
    }
    private fun check(name: String, value: Boolean) { if (!value) throw AssertionError(name); assertions++; sendStatus(0, Bundle().apply { putString("assertion", name) }) }
    private fun waitFor(name: String, seconds: Int, predicate: () -> Boolean) {
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds.toLong())
        while (System.nanoTime() < end) { if (predicate()) { assertions++; return }; Thread.sleep(100) }
        throw AssertionError("Timed out: $name")
    }
    private fun js(script: String): Any? {
        val latch = CountDownLatch(1); var raw: String? = null
        runOnMainSync { host.webView.evaluateJavascript(script) { raw = it; latch.countDown() } }
        if (!latch.await(5, TimeUnit.SECONDS)) throw AssertionError("WebView evaluation timed out")
        return raw?.let { JSONTokener(it).nextValue().let { value -> if (value === JSONObject.NULL) null else value } }
    }
    private fun action(body: String): Any? {
        js("window.__hostTest=null;(async()=>{$body})().then(value=>window.__hostTest={ok:true,value},error=>window.__hostTest={ok:false,code:error.code});true")
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < end) {
            val raw = js("JSON.stringify(window.__hostTest)") as? String
            if (raw != null && raw != "null") { val result = JSONObject(raw); if (!result.getBoolean("ok")) throw AssertionError("Native action failed: "+result.optString("code")); return result.opt("value").let { if (it === JSONObject.NULL) null else it } }
            Thread.sleep(50)
        }
        throw AssertionError("Native action timed out")
    }
}
