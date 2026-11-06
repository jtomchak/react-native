package dev.spahost.prototype

import android.Manifest
import android.app.Activity
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.UUID

/** Native provider boundary. No test tokens, inferred project or sender secret. */
internal object NativePushState {
    private val main = Handler(Looper.getMainLooper())
    private val observers = mutableListOf<Pair<WeakReference<Context>, WeakReference<(String, JSONObject) -> Unit>>>()
    private val queued = ArrayDeque<Pair<String, JSONObject>>()
    @Volatile private var configured = false
    private var registrationInFlight = false
    private var optionsIdentity: String? = null
    fun configure(context: Context, settings: JSONObject?): Boolean {
        if (settings?.optBoolean("enabled") != true) return false
        val firebase = settings.optJSONObject("firebase") ?: return false
        val fields = listOf("applicationId", "apiKey", "projectId", "senderId")
        if (fields.any { firebase.opt(it) !is String || firebase.getString(it).isEmpty() || firebase.getString(it).length > 512 }) return false
        val identity = fields.joinToString("|") { firebase.getString(it) }
        if (optionsIdentity != null && optionsIdentity != identity) return false
        return try {
            if (FirebaseApp.getApps(context).isEmpty()) {
                val options = FirebaseOptions.Builder().setApplicationId(firebase.getString("applicationId")).setApiKey(firebase.getString("apiKey"))
                    .setProjectId(firebase.getString("projectId")).setGcmSenderId(firebase.getString("senderId")).build()
                FirebaseApp.initializeApp(context.applicationContext, options)
            }
            val actual = FirebaseApp.getInstance().options
            if (actual.applicationId != firebase.getString("applicationId") || actual.apiKey != firebase.getString("apiKey") || actual.projectId != firebase.getString("projectId") || actual.gcmSenderId != firebase.getString("senderId")) return false
            optionsIdentity = identity; configured = true; true
        } catch (_: Exception) { false }
    }
    fun status(context: Context, settings: JSONObject?): JSONObject {
        val asked = context.getSharedPreferences("native-permissions", Context.MODE_PRIVATE).getBoolean("notifications.requested", false)
        val permission = if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) { if (asked) "denied" else "notDetermined" }
            else if ((context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).areNotificationsEnabled()) "authorized" else "denied"
        return JSONObject().put("provider", "fcm").put("configured", configure(context, settings)).put("authorization", permission)
    }
    fun register(context: Context, settings: JSONObject?, callback: (String?, HostError?) -> Unit) {
        if (!configure(context, settings)) { callback(null, HostError("UNAVAILABLE", "Development Firebase project is not configured")); return }
        if (status(context, settings).getString("authorization") != "authorized") { callback(null, HostError("UNAUTHORIZED", "Notification permission is not granted")); return }
        if (registrationInFlight) { callback(null, HostError("BUSY", "FCM registration is already pending")); return }
        registrationInFlight = true
        try {
            val messaging = FirebaseMessaging.getInstance(); messaging.isAutoInitEnabled = true
            messaging.token.addOnCompleteListener { task ->
                registrationInFlight = false
                if (!task.isSuccessful || task.result.isNullOrEmpty()) callback(null, HostError("UNAVAILABLE", "FCM registration did not complete"))
                else { val token = task.result; emit("notifications.token", JSONObject().put("provider", "fcm").put("token", token)); callback(token, null) }
            }
        } catch (_: Exception) { registrationInFlight = false; callback(null, HostError("UNAVAILABLE", "FCM registration is unavailable")) }
    }
    fun observe(owner: Context, callback: (String, JSONObject) -> Unit) {
        remove(owner)
        observers.add(WeakReference(owner) to WeakReference(callback))
        while (queued.isNotEmpty()) { val event = queued.removeFirst(); callback(event.first, event.second) }
    }
    fun remove(owner: Context) { observers.removeAll { it.first.get() == null || it.first.get() === owner || it.second.get() == null } }
    fun emit(event: String, data: JSONObject) {
        main.post {
            val callbacks = observers.mapNotNull { it.second.get() }
            if (callbacks.isEmpty()) { if (queued.size == 32) queued.removeFirst(); queued.addLast(event to data) }
            else callbacks.forEach { it(event, data) }
        }
    }
    fun consumeTap(context: Context, intent: Intent): Pair<String, JSONObject>? {
        val id = intent.getStringExtra("spa.notification.tap") ?: return null
        if (!Regex("[a-f0-9-]{36}").matches(id)) return null
        val store = context.getSharedPreferences("notification-taps", Context.MODE_PRIVATE)
        val raw = store.getString(id, null) ?: return null
        // Only service-created one-shot tap receipts count as notification events.
        store.edit().remove(id).commit()
        val data = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        return data.optString("path", "/") to data
    }
    fun message(context: Context, remote: RemoteMessage) {
        val config = runCatching { HostConfiguration.load(context, null) }.getOrNull() ?: return
        if (!configure(context, config.notifications)) return
        val path = remote.data["path"]?.takeIf { config.validRoute(it) } ?: "/"
        val messageID = remote.messageId?.take(256) ?: UUID.randomUUID().toString()
        val received = context.getSharedPreferences("notification-messages", Context.MODE_PRIVATE)
        val ids = received.getStringSet("ids", emptySet())!!.toMutableSet()
        if (!ids.add(messageID)) return
        if (ids.size > 256) ids.remove(ids.first())
        received.edit().putStringSet("ids", ids).apply()
        val data = JSONObject().put("messageId", messageID).put("path", path).put("title", remote.data["title"]?.take(128) ?: "Native actions").put("body", remote.data["body"]?.take(2048) ?: "")
        emit("notifications.received", data)
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        manager.createNotificationChannel(NotificationChannel("native-actions", "Native actions", NotificationManager.IMPORTANCE_DEFAULT))
        val tap = UUID.randomUUID().toString()
        val tapStore = context.getSharedPreferences("notification-taps", Context.MODE_PRIVATE)
        val edits = tapStore.edit()
        if (tapStore.all.size >= 32) tapStore.all.keys.take(tapStore.all.size - 31).forEach { edits.remove(it) }
        edits.putString(tap, data.toString()).commit()
        val intent = Intent(context, HostActivity::class.java).putExtra("spa.notification.tap", tap).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, tap.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, "native-actions").setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(data.getString("title"))
            .setContentText(data.getString("body")).setAutoCancel(true).setContentIntent(pending).build()
        manager.notify(messageID.hashCode(), notification)
    }
}

class HostApplication : Application() {
    internal lateinit var plugins: PluginRuntime
        private set
    internal lateinit var analytics: NativeAnalytics
        private set
    override fun onCreate() {
        super.onCreate()
        plugins = PluginRuntime(this)
        val configuration = runCatching { HostConfiguration.load(this, null) }.getOrNull()
        analytics = NativeAnalytics(this, configuration?.analytics ?: AnalyticsConfiguration(enabled = false))
        runCatching { NativePushState.configure(this, configuration?.notifications) }
        // Started/stopped tracks visible app ownership rather than treating a
        // permission prompt's pause as a process background transition.
        val main = Handler(Looper.getMainLooper())
        var started = 0; var revision = 0
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) { started++; revision++; analytics.setForeground(true) }
            override fun onActivityStopped(activity: Activity) {
                started = (started - 1).coerceAtLeast(0)
                val expected = ++revision
                main.postDelayed({ if (started == 0 && revision == expected) analytics.setForeground(false) }, 500)
            }
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
    }
}

/** Use data-only FCM messages so received/tap provenance stays host-owned. */
class HostMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) { NativePushState.message(this, message) }
    override fun onNewToken(token: String) { NativePushState.emit("notifications.token", JSONObject().put("provider", "fcm").put("token", token)) }
}
