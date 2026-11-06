package dev.nativehost.auth

import android.app.Activity
import android.content.Intent
import android.net.Uri
import dev.nativehost.pluginapi.NativePlugin
import dev.nativehost.pluginapi.PluginAction
import dev.nativehost.pluginapi.PluginCallContext
import dev.nativehost.pluginapi.PluginEnvironment
import dev.nativehost.pluginapi.PluginFailure
import org.json.JSONObject

internal data class AuthCallConfiguration(val auth: AuthConfiguration, val hosted: Boolean, val origin: String, val initialPath: String)

/** Public package entry point. All native SDK state belongs to this instance. */
class AuthPlugin(private val environment: PluginEnvironment) : NativePlugin {
    override val id = "auth"
    override val actions = listOf(
        PluginAction("auth.status", permitsStale = true, coordinatesSession = true),
        PluginAction("auth.signIn", visible = true, requiresFresh = true, coordinatesSession = true, handoffCaller = true, releaseHandoffOnFailure = true),
        PluginAction("auth.registerPasskey", visible = true, coordinatesSession = true),
        PluginAction("auth.signOut", visible = true, permitsStale = true, coordinatesSession = true),
        PluginAction("auth.syncWebSession", visible = true, permitsStale = true, coordinatesSession = true, releaseHandoffOnFailure = true),
    )
    override val events = setOf("auth.changed")
    private val coordinator = NativeAuth(environment.applicationContext)
    private var caller: PluginCallContext? = null
    private var browserPaused = false
    private var changedDuringCall = false
    private var cancelReservation: (() -> Unit)? = null
    init {
        coordinator.eventSink = { summary ->
            changedDuringCall = true
            environment.beginSessionChange(caller?.owner)
            environment.emit("auth.changed", summary)
        }
    }
    override fun invoke(context: PluginCallContext, action: String, args: JSONObject, completion: (Any?, PluginFailure?) -> Unit) {
        val policy = actions.firstOrNull { it.name == action } ?: throw PluginFailure("UNSUPPORTED", "Unknown authentication action")
        val keys = args.keys().asSequence().toSet()
        val expected = if (action == "auth.signIn") {
            when (args.optString("method")) { "oauth" -> setOf("method", "provider"); "passkey" -> setOf("method"); else -> throw PluginFailure("INVALID_REQUEST", "Invalid authentication method") }
        } else emptySet()
        if (keys != expected) throw PluginFailure("INVALID_REQUEST", "Unexpected authentication arguments")
        if (caller != null || coordinator.isBusy) throw PluginFailure("BUSY", "Authentication operation active")
        val plugins = context.configuration.optJSONObject("plugins") ?: JSONObject()
        val raw = if (plugins.has(id)) plugins.optJSONObject(id) ?: throw PluginFailure("INVALID_REQUEST", "Invalid authentication settings") else null
        val auth = AuthConfiguration.parse(raw, if (environment.debug) context.extraSettings["spa.auth.origin"] else null, environment.debug)
        val content = context.configuration.optJSONObject("content") ?: JSONObject()
        val config = AuthCallConfiguration(auth, content.optString("mode") == "hosted", content.optString("origin"), content.optString("initialPath", "/"))
        caller = context; changedDuringCall = false
        val execute: () -> Unit = execute@{
            if (caller !== context) return@execute
            cancelReservation = null
            try {
                coordinator.perform(context.activity, config, context.owner, context.requestId, action, args) { result, failure ->
                    val changed = changedDuringCall
                    if (caller === context) caller = null
                    if (action == "auth.syncWebSession" && failure == null) environment.beginSessionChange(context.owner)
                    completion(result, failure)
                    val refresh = action == "auth.signOut" || (action == "auth.syncWebSession" && failure == null) ||
                        (policy.releaseHandoffOnFailure && failure != null) ||
                        (action == "auth.status" && (result?.optBoolean("authenticated") == false || failure?.code == "UNAUTHORIZED")) || (changed && !policy.handoffCaller)
                    if (refresh) environment.completeSessionChange(context.owner)
                }
            } catch (failure: Exception) {
                if (caller === context) caller = null
                completion(null, failure as? PluginFailure ?: PluginFailure("IO_ERROR", "Native authentication failed"))
                if (policy.releaseHandoffOnFailure) environment.completeSessionChange(context.owner)
            }
        }
        // Destroy non-owning document realms before any new account cookie can
        // be imported. The caller remains concealed and owns the bridge ACK.
        if (action == "auth.syncWebSession" && auth.enabled) {
            cancelReservation = {
                if (caller === context) caller = null
                cancelReservation = null
                completion(null, PluginFailure("CANCELLED", "Authentication operation cancelled"))
                environment.completeSessionChange(context.owner)
            }
            environment.beginSessionChange(context.owner)
            environment.awaitSessionRealms(execute)
        } else execute()
    }
    override fun cancel(owner: String, requestId: String?) {
        val call = caller
        if (call?.owner == owner && (requestId == null || requestId == call.requestId) && cancelReservation != null) cancelReservation?.invoke()
        else coordinator.cancel(owner, requestId)
    }
    override fun consumeIntent(intent: Intent) = coordinator.consumeCallback(intent)
    override fun onActivityPaused(activity: Activity) { if (caller?.activity === activity && coordinator.browserActive) browserPaused = true }
    override fun onActivityResumed(activity: Activity) { if (browserPaused) { browserPaused = false; coordinator.browserReturned() } }
    override fun onActivityDestroyed(activity: Activity) { caller?.takeIf { it.activity === activity }?.let { cancel(it.owner, it.requestId) }; browserPaused = false }
    companion object {
        fun sameOrigin(uri: Uri, origin: String) = NativeAuth.sameOrigin(uri, origin)
        fun validSessionCookie(cookie: String, origin: String) = NativeAuth.validSessionCookie(cookie, origin)
    }
}
