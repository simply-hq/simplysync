plugins {
    kotlin("jvm") version "2.2.10"
    kotlin("plugin.serialization") version "2.2.10"
    `java-library`
}

group = "dev.simplysync"
version = "0.0.1"

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

sourceSets {
    test {
        kotlin.srcDir("../e2e/native/kotlin")
    }
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    api("com.squareup.okhttp3:okhttp:4.12.0")
    // Optional JVM adapter. Keeping this off the runtime graph avoids pulling
    // desktop native binaries into Android apps; JVM users of JdbcSqliteDriver
    // add this same coordinate explicitly.
    compileOnly("org.xerial:sqlite-jdbc:3.45.3.0")
    testRuntimeOnly("org.xerial:sqlite-jdbc:3.45.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}

tasks.withType<Test> {
    useJUnit()
    // The TodoList E2E package owns a long-lived mailbox runner source. Normal
    // tests discover it but skip unless the dedicated harness passes a mailbox.
    (project.findProperty("todoE2eMailbox") as String?)?.let {
        systemProperty("todolistE2eMailbox", it)
    }
    (project.findProperty("todoE2eIdleTimeoutMs") as String?)?.let {
        systemProperty("todolistE2eIdleTimeoutMs", it)
    }
    // Opt into the live two-device test: ./gradlew test -PrelayUrl=http://localhost:4100
    ((project.findProperty("relayUrl") as String?)
        ?: System.getenv("SIMPLYSYNC_RELAY_URL"))?.let {
        systemProperty("SIMPLYSYNC_RELAY_URL", it)
    }
    // Join an existing owner instead of minting one, so a cross-platform run
    // (bun run todo:interop) can point every platform at the same account.
    ((project.findProperty("recoveryKey") as String?)
        ?: System.getenv("SIMPLYSYNC_RECOVERY_KEY"))?.let {
        systemProperty("SIMPLYSYNC_RECOVERY_KEY", it)
    }
}
