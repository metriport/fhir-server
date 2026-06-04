package com.metriport.fhir;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Interceptor;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.server.RequestDetails;

/**
 * Drops {@code _pretty} so responses stay compact (smaller payloads, less formatting CPU).
 */
@Interceptor
public class StripPrettyQueryParameterInterceptor {

	@Hook(Pointcut.SERVER_INCOMING_REQUEST_PRE_HANDLER_SELECTED)
	public void stripPrettyParameter(RequestDetails requestDetails) {
		requestDetails.removeParameter("_pretty");
	}
}
