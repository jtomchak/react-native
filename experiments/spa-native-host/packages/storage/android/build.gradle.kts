plugins { id("com.android.library"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "dev.nativehost.storage"
    compileSdk = 35
    defaultConfig { minSdk = 26 }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies { api(project(":native-host-plugin-api")) }
// Integration suites run in the selected host's instrumentation APK.
androidComponents { beforeVariants(selector().all()) { it.enableAndroidTest = false } }
