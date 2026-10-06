package com.enterprisex.curf.engine;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.Architectures.layeredArchitecture;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

@AnalyzeClasses(packages = "com.enterprisex.curf.engine", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    private static final String BASE = "com.enterprisex.curf.engine";

    @ArchTest
    static final ArchRule layers = layeredArchitecture()
            .consideringOnlyDependenciesInLayers()
            .layer("Domain").definedBy(BASE + ".domain..")
            .layer("Application").definedBy(BASE + ".application..")
            .layer("Infrastructure").definedBy(BASE + ".infrastructure..")
            .layer("Interfaces").definedBy(BASE + ".interfaces..")
            .whereLayer("Interfaces").mayNotBeAccessedByAnyLayer()
            .whereLayer("Infrastructure").mayNotBeAccessedByAnyLayer()
            .whereLayer("Application").mayOnlyBeAccessedByLayers("Interfaces", "Infrastructure")
            .allowEmptyShould(true);

    @ArchTest
    static final ArchRule domainIsFrameworkFree = noClasses()
            .that().resideInAPackage(BASE + ".domain..")
            .should().dependOnClassesThat().resideInAnyPackage("org.springframework..", "jakarta..", "tools.jackson..")
            .allowEmptyShould(true);

    @ArchTest
    static final ArchRule applicationDoesNotKnowTheWeb = noClasses()
            .that().resideInAPackage(BASE + ".application..")
            .should().dependOnClassesThat().resideInAnyPackage("jakarta.servlet..", "org.springframework.web..")
            .allowEmptyShould(true);
}
