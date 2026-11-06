package dev.spahost.prototype

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.os.Bundle
import dev.nativehost.pluginapi.PluginCallContext
import dev.nativehost.pluginapi.PluginEnvironment
import dev.nativehost.pluginapi.PluginFailure
import dev.nativehost.storage.StoragePlugin
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

/** Real bridge plus isolated legacy/quota/admission tests; never clears app data. */
internal class StorageSuite(private val runner: HostInstrumentation, private val arguments: Bundle) {
    private lateinit var host: HostActivity
    private var assertions = 0
    private val key = "storage-test-${UUID.randomUUID()}"
    private lateinit var isolated: File
    private var plugin: StoragePlugin? = null
    fun run() {
        val report = Bundle()
        try {
            host = runner.startActivitySync(Intent(runner.targetContext, HostActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as HostActivity
            waitFor("native document") { host.browserReady && js("typeof platform==='object'&&document.readyState==='complete'") == true }
            check("selected storage advertised", action("return (await platform.ready()).capabilities.includes('storage.get')") == true)
            val quoted = JSONObject.quote(key)
            check("missing scalar is null", action("return await platform.storage.get($quoted)") == null)
            check("set scalar is null", action("return await platform.storage.set($quoted,'')") == null)
            check("empty value preserved", action("return await platform.storage.get($quoted)") == "")
            check("NUL and emoji preserved", action("await platform.storage.set($quoted+'\\u0000😀','a\\u0000b😀');return await platform.storage.get($quoted+'\\u0000😀')") == "a\u0000b😀")
            check("NUL key distinct from prefix", action("return await platform.storage.get($quoted)") == "")
            val malformed = listOf("{key:17}", "{key:'x',extra:true}", "{key:''}", "{key:'é'.repeat(65)}", "{key:'\\ud800'}")
            for (args in malformed) check("strict key validation $args", action("try{await platform.call('storage.get',$args);return 'bad'}catch(e){return e.code}") == "INVALID_REQUEST")
            for (args in listOf("{key:'x',value:null}","{key:'x',value:17}","{key:'x',value:'é'.repeat(16385)}","{key:'x',value:'\\udfff'}")) check("strict value validation", action("try{await platform.call('storage.set',$args);return 'bad'}catch(e){return e.code}") == "INVALID_REQUEST")
            // Seed the pre-package schema on the actual existing path, with one
            // unique owned row; other rows and schema remain untouched.
            val legacyKey = "$key-legacy"
            val db = SQLiteDatabase.openOrCreateDatabase(runner.targetContext.getDatabasePath("platform.sqlite"), null)
            try { db.execSQL("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)"); db.execSQL("INSERT OR REPLACE INTO kv(key,value) VALUES (?,?)", arrayOf(legacyKey,"legacy-native")); check("legacy schema version retained", db.version == 1) } finally { db.close() }
            check("existing platform.sqlite row visible through bridge", action("return await platform.storage.get(${JSONObject.quote(legacyKey)})") == "legacy-native")
            action("await platform.storage.remove(${JSONObject.quote(legacyKey)});await platform.storage.remove($quoted+'\\u0000😀');return true")
            check("remove scalar is null", action("return await platform.storage.remove($quoted)") == null)
            isolatedTests()
            report.putString("status","passed"); report.putInt("assertions",assertions)
            cleanup(); runner.runOnMainSync { host.finish() }; runner.finish(Activity.RESULT_OK,report)
        } catch(error:Throwable) {
            report.putString("status","failed"); report.putInt("assertions",assertions); report.putString("error",error.toString()); report.putString("stack",error.stackTraceToString())
            cleanup(); if(::host.isInitialized) runner.runOnMainSync { host.finish() }; runner.finish(1,report)
        }
    }
    private fun isolatedTests() {
        isolated = File(runner.targetContext.noBackupFilesDir,"storage-plugin-tests/${UUID.randomUUID()}").apply { mkdirs() }
        val context = object:ContextWrapper(runner.targetContext) {
            override fun getApplicationContext():Context = this
            override fun getDatabasePath(name:String):File = File(isolated,name)
            override fun openOrCreateDatabase(name:String,mode:Int,factory:SQLiteDatabase.CursorFactory?):SQLiteDatabase = SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name),factory)
            override fun openOrCreateDatabase(name:String,mode:Int,factory:SQLiteDatabase.CursorFactory?,errorHandler:DatabaseErrorHandler?):SQLiteDatabase = SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name).path,factory,errorHandler)
        }
        val legacy=SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath("platform.sqlite"),null)
        legacy.execSQL("CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)"); legacy.version=1
        legacy.execSQL("INSERT INTO kv VALUES ('legacy','before-extraction')"); legacy.close()
        val service=StoragePlugin(PluginEnvironment(context,true,{_,_->},{_ ->},{_ ->},{it()})); plugin=service
        check("isolated legacy database reused", call("storage.get",JSONObject().put("key","legacy")).first == "before-extraction")
        call("storage.remove",JSONObject().put("key","legacy"))
        val boundary="é".repeat(64)
        check("128-byte key and 32768-byte value accepted", call("storage.set",JSONObject().put("key",boundary).put("value","é".repeat(16384))).second == null)
        check("UTF8 boundary roundtrip", call("storage.get",JSONObject().put("key",boundary)).first == "é".repeat(16384))
        call("storage.remove",JSONObject().put("key",boundary))
        // Fill exactly one MiB, including keys, without touching the app's DB.
        var used=0
        for(i in 0..30) { val k="q$i"; check("quota seed $i",call("storage.set",JSONObject().put("key",k).put("value","x".repeat(32768))).second == null); used+=k.length+32768 }
        val tail="tail"; val remaining=1024*1024-used-tail.length
        check("exact quota admitted",call("storage.set",JSONObject().put("key",tail).put("value","x".repeat(remaining))).second == null)
        check("quota excess rejected",call("storage.set",JSONObject().put("key","z").put("value","")).second?.code == "QUOTA_EXCEEDED")
        check("quota failure leaves previous value",(call("storage.get",JSONObject().put("key",tail)).first as? String)?.length == remaining)
        check("replacement releases byte accounting",call("storage.set",JSONObject().put("key",tail).put("value","")).second == null)
        check("released quota usable",call("storage.set",JSONObject().put("key","z").put("value","ok")).second == null)
        val executor=executor(service); val entered=CountDownLatch(1); val release=CountDownLatch(1)
        executor.execute { entered.countDown(); release.await(20,TimeUnit.SECONDS) }; check("queue worker blocked",entered.await(3,TimeUnit.SECONDS))
        val completed=CountDownLatch(64)
        try {
            runner.runOnMainSync { repeat(64) { i -> service.invoke(contextFor("accepted-$i"),"storage.set",JSONObject().put("key","cancelled").put("value","committed")) { _,error -> if(error != null) throw AssertionError(error.code); completed.countDown() }; service.cancel("test","accepted-$i") } }
            check("cancel does not free accepted capacity",call("storage.get",JSONObject().put("key","z")).second?.code == "QUOTA_EXCEEDED")
        } finally { release.countDown() }
        check("accepted cancelled work drains",completed.await(20,TimeUnit.SECONDS))
        check("accepted write can commit after cancel",call("storage.get",JSONObject().put("key","cancelled")).first == "committed")
        check("capacity recovers after real completion",call("storage.get",JSONObject().put("key","z")).first == "ok")
    }
    private fun contextFor(id:String) = PluginCallContext(host,"test",id,JSONObject())
    private fun call(action:String,args:JSONObject):Pair<Any?,PluginFailure?> {
        val latch=CountDownLatch(1); var value:Any?=null; var failure:PluginFailure?=null
        runner.runOnMainSync { try { plugin!!.invoke(contextFor(UUID.randomUUID().toString()),action,args) { v,e -> value=v; failure=e; latch.countDown() } } catch(e:PluginFailure) { failure=e; latch.countDown() } }
        check(latch.await(20,TimeUnit.SECONDS)) { "Storage completion timeout" }; return value to failure
    }
    private fun executor(service:StoragePlugin):ExecutorService = StoragePlugin::class.java.getDeclaredField("executor").apply { isAccessible=true }.get(service) as ExecutorService
    private fun cleanup() { plugin?.let { service -> val ex=executor(service); val done=CountDownLatch(1); ex.execute { (StoragePlugin::class.java.getDeclaredField("database").apply { isAccessible=true }.get(service) as android.database.sqlite.SQLiteOpenHelper).close(); done.countDown() }; done.await(5,TimeUnit.SECONDS); ex.shutdown(); ex.awaitTermination(5,TimeUnit.SECONDS) }; if(::isolated.isInitialized) isolated.deleteRecursively() }
    private fun check(name:String,ok:Boolean) { if(!ok) throw AssertionError(name); assertions++; runner.sendStatus(0,Bundle().apply { putString("assertion",name) }) }
    private fun waitFor(name:String,condition:()->Boolean) { val end=System.nanoTime()+TimeUnit.SECONDS.toNanos(40); while(System.nanoTime()<end) { if(condition()) { assertions++; return }; Thread.sleep(100) }; throw AssertionError("Timed out: $name") }
    private fun js(script:String):Any? { val latch=CountDownLatch(1); var raw:String?=null; runner.runOnMainSync { host.webView.evaluateJavascript(script) { raw=it; latch.countDown() } }; check(latch.await(5,TimeUnit.SECONDS)); return raw?.let { JSONTokener(it).nextValue().let { v -> if(v===JSONObject.NULL) null else v } } }
    private fun action(body:String):Any? { js("window.__storageTest=null;(async()=>{$body})().then(value=>window.__storageTest={ok:true,value},e=>window.__storageTest={ok:false,code:e.code});true"); val end=System.nanoTime()+TimeUnit.SECONDS.toNanos(20); while(System.nanoTime()<end) { val raw=js("JSON.stringify(window.__storageTest)") as? String; if(raw!=null&&raw!="null") { val r=JSONObject(raw); check(r.getBoolean("ok")) { "Native action: ${r.optString("code")}" }; return r.opt("value").let { if(it===JSONObject.NULL) null else it } }; Thread.sleep(50) }; throw AssertionError("Storage action timeout") }
}
