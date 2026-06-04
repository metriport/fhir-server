package com.metriport.fhir;

import org.hl7.fhir.common.hapi.validation.validator.FhirInstanceValidator;
import org.hl7.fhir.r5.utils.validation.constants.BestPracticeWarningLevel;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Conditional;

import ca.uhn.fhir.jpa.starter.annotations.OnR4Condition;

/**
 * Lighter {@code $validate}: structure + reference checks only (no terminology, profiles, or best-practice rules).
 */
@Configuration
@Conditional(OnR4Condition.class)
public class MetriportValidatorConfig {

	@Bean
	static BeanPostProcessor instanceValidatorCustomizer() {
		return new BeanPostProcessor() {
			@Override
			public Object postProcessAfterInitialization(Object bean, String beanName) {
				if (!"myInstanceValidator".equals(beanName) || !(bean instanceof FhirInstanceValidator)) {
					return bean;
				}
				FhirInstanceValidator validator = (FhirInstanceValidator) bean;
				validator.setNoTerminologyChecks(true);
				validator.setNoExtensibleWarnings(true);
				validator.setBestPracticeWarningLevel(BestPracticeWarningLevel.Ignore);
				validator.setErrorForUnknownProfiles(false);
				validator.setAssumeValidRestReferences(false);
				return validator;
			}
		};
	}
}
