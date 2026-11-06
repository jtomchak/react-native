package dev.spahost.prototype

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Verifies the acknowledged checkpoint from storage-host after process death. */
internal class StoragePersistenceSuite(private val runner: HostInstrumentation, private val arguments: Bundle) {
    fun run() {
        val report = Bundle(); var host: HostActivity? = null; var assertions = 0
        try {
            val prefix = arguments.getString("prefix") ?: throw AssertionError("Missing test-owned checkpoint prefix")
            require(Regex("storage-host-[a-f0-9-]{36}:").matches(prefix))
            val expected = arguments.getString("expected") ?: throw AssertionError("Missing expected checkpoint")
            val activity = runner.startActivitySync(Intent(runner.targetContext, HostActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as HostActivity
            host = activity
            val end = System.nanoTime()+TimeUnit.SECONDS.toNanos(40)
            while (!activity.browserReady && System.nanoTime()<end) Thread.sleep(100)
            check(activity.browserReady); assertions++; report.putInt("pid", android.os.Process.myPid())
            fun js(script: String): String? { val latch=CountDownLatch(1); var result:String?=null; runner.runOnMainSync { activity.webView.evaluateJavascript(script) { result=it; latch.countDown() } }; check(latch.await(5,TimeUnit.SECONDS)); return result }
            val key=JSONObject.quote(prefix+"restart-checkpoint"); val unicode=JSONObject.quote(prefix+"unicode-prefix\u0000😀"); val ordinary=JSONObject.quote(prefix+"unicode-prefix")
            js("window.__persist=null;(async()=>{const a=await platform.storage.get($key),b=await platform.storage.get($unicode),c=await platform.storage.get($ordinary);const ok=a===${JSONObject.quote(expected)}&&b==='before\\u0000after😀'&&c==='prefix-value';await platform.storage.remove($key);await platform.storage.remove($unicode);await platform.storage.remove($ordinary);window.__persist={ok}})().catch(()=>window.__persist={ok:false});true")
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(20); var passed=false
            while (System.nanoTime()<deadline) { if(js("window.__persist&&window.__persist.ok") == "true") { passed=true; break }; Thread.sleep(100) }
            check(passed); assertions++
            report.putString("status","passed"); report.putInt("assertions",assertions)
            runner.runOnMainSync { activity.finish() }; runner.finish(Activity.RESULT_OK,report)
        } catch(error:Throwable) { report.putString("status","failed"); report.putString("error",error.toString()); report.putInt("assertions",assertions); host?.let { runner.runOnMainSync { it.finish() } }; runner.finish(1,report) }
    }
}
