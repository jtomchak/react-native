plugins { id("com.android.library"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "dev.nativehost.auth"
    compileSdk = 35
    defaultConfig { minSdk = 26 }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    api(project(":native-host-plugin-api"))
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    implementation("androidx.browser:browser:1.8.0")
}
// Package integration suites run in the selected host's real instrumentation APK.
androidComponents { beforeVariants(selector().all()) { it.enableAndroidTest = false } }
