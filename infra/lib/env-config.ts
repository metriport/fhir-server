import { EnvType } from "./env-type";

export type EnvConfig = {
  environmentType: EnvType;
  region: string;
  vpcId: string;
  zone: {
    // Private hosted zone for this region
    id: string;
    name: string;
  };
  domain: string;
  subdomain: string;
  fhirDatabase: {
    /**
     * The name of the database.
     */
    name: string;
    /**
     * The FHIR username to connect to the database.
     */
    username: string;
    /**
     * From CDK: A preferred maintenance window day/time range. Should be specified as a range ddd:hh24:mi-ddd:hh24:mi (24H Clock UTC).
     *
     * Example: 'Sun:23:45-Mon:00:15'.
     *
     * Must be at least 30 minutes long.
     *
     * @see: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_UpgradeDBInstance.Maintenance.html#Concepts.DBMaintenance
     */
    maintenanceWindow: string;
    /**
     * From CDK: The minimum number of Aurora capacity units (ACUs) for a DB instance in an Aurora Serverless v2 cluster.
     *
     * You can specify ACU values in half-step increments, such as 8, 8.5, 9, and so on. The smallest value that you can use is 0.5.
     *
     * @see — http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-rds-dbcluster-serverlessv2scalingconfiguration.html#cfn-rds-dbcluster-serverlessv2scalingconfiguration-mincapacity
     */
  };
  slack?: {
    workspaceId: string;
    alertsChannelId: string;
    snsTopicArn: string;
  };
};
