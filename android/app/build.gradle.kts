plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
}

android {
  namespace = "com.recall.voice"
  compileSdk = 34

  defaultConfig {
    applicationId = "com.recall.voice"
    minSdk = 26
    targetSdk = 34
    versionCode = 1
    versionName = "0.1.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
    debug {
      isDebuggable = true
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  buildFeatures {
    compose = true
  }

  composeOptions {
    kotlinCompilerExtensionVersion = "1.5.15"
  }

  packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
  }

  testOptions {
    unitTests.isIncludeAndroidResources = true
  }

  sourceSets["main"].java.srcDirs("src/main/kotlin")
  sourceSets["test"].java.srcDirs("src/test/kotlin")
}

dependencies {
  // Compose
  val composeBom = platform("androidx.compose:compose-bom:2024.10.00")
  implementation(composeBom)
  androidTestImplementation(composeBom)

  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-extended")
  debugImplementation("androidx.compose.ui:ui-tooling")

  // Activity + lifecycle
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")

  // DataStore
  implementation("androidx.datastore:datastore-preferences:1.1.1")

  // Networking + serialization
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

  // Coroutines
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

  // Tests
  testImplementation("org.junit.jupiter:junit-jupiter:5.10.3")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")

  // Screenshot tests: JUnit 4 Robolectric tests run on the JUnit Platform through the vintage engine.
  testImplementation(composeBom)
  testImplementation("junit:junit:4.13.2")
  testRuntimeOnly("org.junit.vintage:junit-vintage-engine:5.10.3")
  testImplementation("org.robolectric:robolectric:4.13")
  testImplementation("io.github.takahirom.roborazzi:roborazzi:1.26.0")
  testImplementation("io.github.takahirom.roborazzi:roborazzi-junit-rule:1.26.0")
  testImplementation("androidx.compose.ui:ui-test-junit4")
  debugImplementation("androidx.compose.ui:ui-test-manifest")
}

tasks.withType<Test> {
  useJUnitPlatform()
  // Screenshot tests write their PNGs on every run instead of comparing against goldens.
  systemProperty("roborazzi.test.record", "true")
  systemProperty("recall.review.dir", rootProject.file("../.impeccable/review").absolutePath)
}
