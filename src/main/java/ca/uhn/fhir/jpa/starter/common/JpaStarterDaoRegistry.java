package ca.uhn.fhir.jpa.starter.common;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.api.dao.IFhirResourceDao;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.Nullable;
import org.springframework.context.ApplicationContext;


/**
 * The standard HAPI FHIR DaoRegistry no longer auto-registers DAOs, so this is a custom implementation that
 * initializes the registry with DAO from the application context.
 */
public class JpaStarterDaoRegistry extends DaoRegistry {
	private final ApplicationContext myApplicationContext;
	private final FhirContext myFhirContext;
	private boolean myInitialized;

	public JpaStarterDaoRegistry(FhirContext theFhirContext, ApplicationContext theApplicationContext) {
		super(theFhirContext);
		myFhirContext = theFhirContext;
		myApplicationContext = theApplicationContext;
	}

	@Override
	public @Nullable <R extends IBaseResource, D extends IFhirResourceDao<R>> D getResourceDaoOrNull(
			Class<R> theResourceType) {
		initializeIfNeeded();
		return super.getResourceDaoOrNull(theResourceType);
	}

	private void initializeIfNeeded() {
		if (!myInitialized) {
			myApplicationContext.getBeansOfType(IFhirResourceDao.class).values().forEach(this::register);
			myInitialized = true;
		}
	}

	@Override
	public <R extends IBaseResource, D extends IFhirResourceDao<R>> D getResourceDaoOrNull(String theResourceName) {
		initializeIfNeeded();
		return super.getResourceDaoOrNull(theResourceName);
	}

	@Override
	public void register(@NonNull IFhirResourceDao theResourceDao) {
		String resourceName = myFhirContext
				.getResourceDefinition(theResourceDao.getResourceType())
				.getName();
		if (super.getResourceDaoOrNull(resourceName) != null) {
			return;
		}
		super.register(theResourceDao);
	}
}
