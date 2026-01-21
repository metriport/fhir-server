import { EnvConfig } from "../lib/env-config";
import { EnvType } from "../lib/env-type";

export const config: EnvConfig = {
  environmentType: EnvType.production,
  region: "us-east-1",
  vpcId: "my_vpcId",
  zone: {
    id: "xxxx",
    name: "xxx.metriport.com",
  },
  domain: "metriport.com",
  subdomain: "fhir",
  fhirDatabase: {
    name: "my_db",
    username: "my_db_user",
    maintenanceWindow: "Sun:02:00-Sun:02:30",
  },
};
export default config;
