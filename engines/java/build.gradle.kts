plugins {
    java
    jacoco
    id("org.springframework.boot") version "4.1.1"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "com.enterprisex.curf"
version = "0.1.0"

java {
    toolchain { languageVersion = JavaLanguageVersion.of(25) }
}

repositories { mavenCentral() }

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-security-oauth2-resource-server")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-mail")
    implementation("org.springframework.boot:spring-boot-starter-liquibase")
    implementation("io.micrometer:micrometer-registry-prometheus")
    implementation("com.github.jsqlparser:jsqlparser:5.4")
    implementation("org.apache.poi:poi-ooxml:5.5.1")
    runtimeOnly("org.postgresql:postgresql")
    runtimeOnly("com.mysql:mysql-connector-j")
    runtimeOnly("org.mariadb.jdbc:mariadb-java-client")
    runtimeOnly("com.oracle.database.jdbc:ojdbc11")
    runtimeOnly("com.microsoft.sqlserver:mssql-jdbc")
    // Trino is optional; its driver is small and nothing loads it unless a TRINO connection is made.
    runtimeOnly("io.trino:trino-jdbc:483")

    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
    testImplementation("org.springframework.boot:spring-boot-starter-security-test")
    testImplementation("com.tngtech.archunit:archunit-junit5:1.5.1")
    testImplementation("org.apache.pdfbox:pdfbox:3.0.8")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> {
    useJUnitPlatform()
    finalizedBy(tasks.jacocoTestReport)
}

tasks.jacocoTestReport {
    dependsOn(tasks.test)
    reports { xml.required = true }
}

tasks.jacocoTestCoverageVerification {
    violationRules {
        rule { limit { minimum = "0.80".toBigDecimal() } }
    }
}

tasks.check { dependsOn(tasks.jacocoTestCoverageVerification) }
