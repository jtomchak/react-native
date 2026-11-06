plugins { id("com.android.library"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "dev.nativehost.pluginapi"
    compileSdk = 35
    defaultConfig { minSdk = 26 }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
androidComponents { beforeVariants(selector().all()) { it.enableAndroidTest = false } }
