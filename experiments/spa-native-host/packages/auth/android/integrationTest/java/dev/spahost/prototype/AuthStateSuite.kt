package dev.spahost.prototype

import android.app.Activity
import android.os.Bundle
import dev.nativehost.auth.AuthVault

internal class AuthStateSuite(private val runner: HostInstrumentation, private val arguments: Bundle) {
    fun run() {
        val origin = arguments.getString("origin") ?: "http://127.0.0.1:18803"
        val state = Bundle()
        state.putBoolean("nativeCredentialPresent", AuthVault(runner.targetContext).read(origin) != null)
        state.putBoolean("webCookiePresent", android.webkit.CookieManager.getInstance().getCookie(origin)?.contains("spa_dev_session=") == true)
        state.putString("status", "observed")
        runner.finish(Activity.RESULT_OK, state)
    }
}
