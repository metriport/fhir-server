package com.metriport.fhir;

import java.util.concurrent.atomic.AtomicBoolean;

import org.hl7.fhir.common.hapi.validation.validator.FhirInstanceValidator;
import org.hl7.fhir.r5.utils.validation.constants.BestPracticeWarningLevel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.SmartInitializingSingleton;
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

	private static final Logger log = LoggerFactory.getLogger(MetriportValidatorConfig.class);

	@Bean
	static BeanPostProcessor instanceValidatorCustomizer() {
		return new InstanceValidatorCustomizer();
	}

	private static final class InstanceValidatorCustomizer implements BeanPostProcessor, SmartInitializingSingleton {

		private final AtomicBoolean configured = new AtomicBoolean(false);

		@Override
		public Object postProcessAfterInitialization(Object bean, String beanName) {
			if (!(bean instanceof FhirInstanceValidator)) {
				return bean;
			}
			FhirInstanceValidator validator = (FhirInstanceValidator) bean;
			validator.setNoTerminologyChecks(true);
			validator.setNoExtensibleWarnings(true);
			validator.setBestPracticeWarningLevel(BestPracticeWarningLevel.Ignore);
			validator.setErrorForUnknownProfiles(false);
			validator.setAssumeValidRestReferences(true); // Don't hit db for reference checks
			configured.set(true);
			log.info("Applied Metriport validation settings to FhirInstanceValidator bean '{}'", beanName);
			return validator;
		}

		@Override
		public void afterSingletonsInstantiated() {
			if (!configured.get()) {
				log.warn("No FhirInstanceValidator bean found; Metriport validation settings were not applied");
			}
		}
	}
}
