FROM --platform=linux/amd64 maven:3.8-openjdk-17-slim as build-fhir
WORKDIR /tmp/hapi-fhir-jpaserver-starter

ARG OPENTELEMETRY_JAVA_AGENT_VERSION=1.17.0
RUN curl -LSsO https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v${OPENTELEMETRY_JAVA_AGENT_VERSION}/opentelemetry-javaagent.jar

COPY pom.xml .
COPY server.xml .
RUN mvn -ntp dependency:go-offline

COPY src/ ./src/
RUN mvn clean install -DskipTests -Djdk.lang.Process.launchMechanism=vfork

FROM --platform=linux/amd64 build-fhir AS build-distroless
# if this fails to build on a MacOS M2 (keeps testing or compiling for more than 5 min), add "-DskipTests" after package
RUN mvn package spring-boot:repackage -Pboot
RUN mkdir /app && cp ./target/ROOT.war /app/main.war

########### distroless brings focus on security and runs on plain spring boot - this is the default image
FROM --platform=linux/amd64 gcr.io/distroless/java17-debian11:nonroot as default
# 65532 is the nonroot user's uid
# used here instead of the name to allow Kubernetes to easily detect that the container
# is running as a non-root (uid != 0) user.
USER 65532:65532
WORKDIR /app

COPY --chown=nonroot:nonroot --from=build-distroless /app /app
COPY --chown=nonroot:nonroot --from=build-fhir /tmp/hapi-fhir-jpaserver-starter/opentelemetry-javaagent.jar /app

ENTRYPOINT ["java", "--class-path", "/app/main.war", "-Dloader.path=main.war!/WEB-INF/classes/,main.war!/WEB-INF/,/app/extra-classes", "org.springframework.boot.loader.PropertiesLauncher", "app/main.war"]
