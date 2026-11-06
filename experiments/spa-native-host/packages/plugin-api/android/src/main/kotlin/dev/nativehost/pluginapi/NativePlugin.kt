package dev.nativehost.pluginapi

import android.app.Activity
import android.content.Context
import android.content.Intent
import org.json.JSONObject

class PluginFailure(val code: String, message: String) : Exception(message)

data class PluginAction(
    val name: String,
    val visible: Boolean = false,
    val permitsStale: Boolean = false,
    val requiresFresh: Boolean = false,
    val coordinatesSession: Boolean = false,
    val handoffCaller: Boolean = false,
    val releaseHandoffOnFailure: Boolean = false,
)

/** Process services supplied by the native host; no host implementation types. */
class PluginEnvironment(
    val applicationContext: Context,
    val debug: Boolean,
    val emit: (String, JSONObject) -> Unit,
    val beginSessionChange: (String?) -> Unit,
    val completeSessionChange: (String?) -> Unit,
    val awaitSessionRealms: (() -> Unit) -> Unit,
)

/** Per-call scene/activity, document ownership and public configuration. */
data class PluginCallContext(
    val activity: Activity,
    val owner: String,
    val requestId: String,
    val configuration: JSONObject,
    val extraSettings: Map<String, String> = emptyMap(),
)

interface NativePlugin {
    val id: String
    val actions: List<PluginAction>
    val events: Set<String>
    fun invoke(context: PluginCallContext, action: String, args: JSONObject, completion: (JSONObject?, PluginFailure?) -> Unit)
    fun cancel(owner: String, requestId: String? = null) {}
    fun consumeIntent(intent: Intent): Boolean = false
    fun onActivityPaused(activity: Activity) {}
    fun onActivityResumed(activity: Activity) {}
    fun onActivityDestroyed(activity: Activity) {}
}
