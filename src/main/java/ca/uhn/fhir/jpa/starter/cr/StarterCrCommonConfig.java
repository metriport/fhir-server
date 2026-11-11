package ca.uhn.fhir.jpa.starter.cr;

import org.opencds.cqf.fhir.cql.EvaluationSettings;
import org.opencds.cqf.fhir.cql.engine.retrieve.RetrieveSettings;
import org.opencds.cqf.fhir.cql.engine.terminology.TerminologySettings;
import org.opencds.cqf.fhir.cr.measure.CareGapsProperties;
import org.opencds.cqf.fhir.cr.measure.MeasureEvaluationOptions;
import org.opencds.cqf.fhir.utility.client.TerminologyServerClientSettings;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

@Configuration
@Conditional(CrConfigCondition.class)
public class StarterCrCommonConfig {
  @Bean
  public EvaluationSettings evaluationSettings() {
    return EvaluationSettings.getDefault();
  }

  @Bean
  public RetrieveSettings retrieveSettings(EvaluationSettings settings) {
    return settings.getRetrieveSettings();
  }

  @Bean
  public TerminologySettings terminologySettings(EvaluationSettings settings) {
    return settings.getTerminologySettings();
  }

  @Bean
  public TerminologyServerClientSettings terminologyServerClientSettings() {
    return TerminologyServerClientSettings.getDefault();
  }

  @Bean
  public MeasureEvaluationOptions measureEvaluationOptions(EvaluationSettings settings) {
    MeasureEvaluationOptions options = new MeasureEvaluationOptions();
    options.setEvaluationSettings(settings);
    return options;
  }

  @Bean(name = "measure.CareGapsProperties")
  public CareGapsProperties careGapsProperties() {
    return new CareGapsProperties();
  }
}
