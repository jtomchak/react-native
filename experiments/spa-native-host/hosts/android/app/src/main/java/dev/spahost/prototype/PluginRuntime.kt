package dev.spahost.prototype

import android.app.Activity
import android.content.Context
import android.content.Intent
import dev.nativehost.pluginapi.NativePlugin
import dev.nativehost.pluginapi.PluginAction
import dev.nativehost.pluginapi.PluginCallContext
import dev.nativehost.pluginapi.PluginEnvironment
import dev.nativehost.pluginapi.PluginFailure
import org.json.JSONObject

/** Process-owned registry; package selection is generated, never hand linked. */
internal class PluginRuntime(context: Context) {
    companion object {
        internal fun validIdentifier(value: String) = Regex("[a-z][A-Za-z0-9_.]{1,63}").matches(value)
    }
    var eventSink: ((String, JSONObject) -> Unit)? = null
    var beginSessionChange: ((String?) -> Unit)? = null
    var completeSessionChange: ((String?) -> Unit)? = null
    private var boundOwner: Any? = null
    private val environment = PluginEnvironment(context.applicationContext, BuildConfig.DEBUG,
        { name, value -> eventSink?.invoke(name, value) },
        { owner -> beginSessionChange?.invoke(owner) },
        { owner -> completeSessionChange?.invoke(owner) },
        { completion -> completion() }) // WebView.destroy retires Android realms synchronously.
    val instances: List<NativePlugin> = GeneratedPluginRegistry.make(environment)
    private val owners = linkedMapOf<String, NativePlugin>()
    val actions = linkedMapOf<String, PluginAction>()
    val events: Set<String>
    init {
        val eventNames = linkedSetOf<String>()
        val ids = linkedSetOf<String>()
        for (plugin in instances) {
            require(ids.add(plugin.id)) { "Duplicate native plugin identity" }
            for (action in plugin.actions) {
                require(validIdentifier(action.name) && !actions.containsKey(action.name)) { "Invalid or duplicate plugin action" }
                actions[action.name] = action; owners[action.name] = plugin
            }
            for (event in plugin.events) require(validIdentifier(event) && eventNames.add(event)) { "Invalid or duplicate plugin event" }
        }
        events = eventNames
    }
    fun bind(owner: Any, emit: (String, JSONObject) -> Unit, begin: (String?) -> Unit, complete: (String?) -> Unit) {
        boundOwner = owner; eventSink = emit; beginSessionChange = begin; completeSessionChange = complete
    }
    fun unbind(owner: Any) { if (boundOwner === owner) { boundOwner = null; eventSink = null; beginSessionChange = null; completeSessionChange = null } }
    fun invoke(context: PluginCallContext, action: String, args: JSONObject, completion: (Any?, HostError?) -> Unit) {
        val plugin = owners[action] ?: throw HostError("UNSUPPORTED", "Native plugin action is not installed")
        try {
            plugin.invoke(context, action, args) { result, failure -> completion(result, failure?.let { HostError(it.code, it.message ?: "Native plugin failed") }) }
        } catch (failure: PluginFailure) { throw HostError(failure.code, failure.message ?: "Native plugin failed") }
    }
    fun cancel(owner: String, requestId: String? = null) { instances.forEach { it.cancel(owner, requestId) } }
    fun consumeIntent(intent: Intent): Boolean = instances.any { it.consumeIntent(intent) }
    fun paused(activity: Activity) { instances.forEach { it.onActivityPaused(activity) } }
    fun resumed(activity: Activity) { instances.forEach { it.onActivityResumed(activity) } }
    fun destroyed(activity: Activity) { instances.forEach { it.onActivityDestroyed(activity) } }
}
