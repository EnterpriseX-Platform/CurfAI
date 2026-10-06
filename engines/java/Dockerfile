FROM gradle:9.8.0-jdk25 AS build
WORKDIR /src
COPY settings.gradle.kts build.gradle.kts ./
COPY src ./src
RUN gradle bootJar --no-daemon -x test --console=plain

FROM eclipse-temurin:25-jre AS runtime
RUN groupadd --system --gid 10001 engine \
 && useradd --system --uid 10001 --gid engine --no-create-home --shell /usr/sbin/nologin engine \
 && mkdir -p /opt/curf/drivers && chown engine:engine /opt/curf/drivers
WORKDIR /app
COPY --from=build --chown=engine:engine /src/build/libs/curf-engine-*.jar /app/engine.jar
USER 10001:10001
EXPOSE 8080
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
ENTRYPOINT ["java", "-jar", "/app/engine.jar"]
