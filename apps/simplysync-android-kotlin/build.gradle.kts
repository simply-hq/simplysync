plugins {
    kotlin("jvm") version "2.2.10"
    kotlin("plugin.serialization") version "2.2.10"
}

repositories {
    mavenCentral()
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Pure-JVM SQLite for the engine's default driver (and host tests). Android
    // apps inject their own android.database-backed SqliteDriver instead.
    implementation("org.xerial:sqlite-jdbc:3.45.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}

tasks.withType<Test> {
    useJUnit()
    // Opt into the live two-device test: ./gradlew test -PrelayUrl=http://localhost:4100
    (project.findProperty("relayUrl") as String?)?.let { systemProperty("SIMPLYSYNC_RELAY_URL", it) }
}
