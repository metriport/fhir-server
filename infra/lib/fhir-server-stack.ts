import { Aspects, CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { InstanceType } from "aws-cdk-lib/aws-ec2";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { FargateService } from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import { Protocol } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import { Credentials } from "aws-cdk-lib/aws-rds";
import * as r53 from "aws-cdk-lib/aws-route53";
import * as r53_targets from "aws-cdk-lib/aws-route53-targets";
import * as secret from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import { ITopic } from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { EnvConfig } from "./env-config";
import { getConfig } from "./shared/config";
import { vCPU } from "./shared/fargate";
import { isProd, mbToBytes } from "./util";

export function settings() {
  const config = getConfig();
  const prod = isProd(config);
  return {
    cpu: prod ? 2 * vCPU : 1 * vCPU,
    memoryLimitMiB: prod ? 4096 : 2048,
    taskCountMin: prod ? 2 : 1,
    taskCountMax: prod ? 10 : 5,
    minDBCap: prod ? 4 : 1,
    maxDBCap: prod ? 32 : 8,
    // The load balancer idle timeout, in seconds. Can be between 1 and 4000 seconds
    maxExecutionTimeout: Duration.minutes(15),
    listenToPort: 8080,
  };
}

interface FHIRServerProps extends StackProps {
  config: EnvConfig;
}

// TODO Consider moving infra parameters to the configuration files (EnvConfig)
export class FHIRServerStack extends Stack {
  readonly vpc: ec2.IVpc;
  readonly zone: r53.IHostedZone;

  constructor(scope: Construct, id: string, props: FHIRServerProps) {
    super(scope, id, props);

    // Initialize the stack w/ variables and references to existing assets
    this.vpc = ec2.Vpc.fromLookup(this, "APIVpc", {
      vpcId: props.config.vpcId,
    });
    this.zone = r53.HostedZone.fromHostedZoneAttributes(this, "FhirZone", {
      zoneName: props.config.zone.name,
      hostedZoneId: props.config.zone.id,
    });

    const slackNotification = setupSlackNotifSnsTopic(this, props.config);

    //-------------------------------------------
    // Aurora Database
    //-------------------------------------------
    const { dbCluster, dbCreds } = this.setupDB(
      props,
      slackNotification?.alarmAction
    );

    //-------------------------------------------
    // ECS + Fargate for FHIR Server
    //-------------------------------------------
    const fargateService = this.setupFargateService(
      props,
      dbCluster,
      dbCreds,
      slackNotification?.alarmAction
    );

    //-------------------------------------------
    // Output
    //-------------------------------------------
    new CfnOutput(this, "FargateServiceARN", {
      description: "Fargate Service ARN",
      value: fargateService.serviceArn,
    });
    new CfnOutput(this, "DBClusterID", {
      description: "DB Cluster ID",
      value: dbCluster.clusterIdentifier,
    });
    new CfnOutput(this, "FHIRServerDBCluster", {
      description: "FHIR server DB Cluster",
      value: `${dbCluster.clusterEndpoint.hostname} ${dbCluster.clusterEndpoint.port} ${dbCluster.clusterEndpoint.socketAddress}`,
    });
  }

  private setupDB(
    props: FHIRServerProps,
    alarmAction?: SnsAction
  ): {
    dbCluster: rds.IDatabaseCluster;
    dbCreds: { username: string; password: secret.Secret };
  } {
    const { minDBCap, maxDBCap } = settings();

    // create database credentials
    const dbClusterName = "fhir-server";
    const dbName = props.config.dbName;
    const dbUsername = props.config.dbUsername;
    const dbPasswordSecret = new secret.Secret(this, "FHIRServerDBPassword", {
      secretName: "FHIRServerDBPassword",
      generateSecretString: {
        excludePunctuation: true,
        includeSpace: false,
      },
    });
    const dbCreds = Credentials.fromPassword(
      dbUsername,
      dbPasswordSecret.secretValue
    );
    // aurora serverlessv2 db
    const dbCluster = new rds.DatabaseCluster(this, "FHIR_DB", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_14_4,
      }),
      instanceProps: {
        vpc: this.vpc,
        instanceType: new InstanceType("serverless"),
      },
      credentials: dbCreds,
      defaultDatabaseName: dbName,
      clusterIdentifier: dbClusterName,
      storageEncrypted: true,
    });

    Aspects.of(dbCluster).add({
      visit(node) {
        if (node instanceof rds.CfnDBCluster) {
          node.serverlessV2ScalingConfiguration = {
            minCapacity: minDBCap,
            maxCapacity: maxDBCap,
          };
        }
      },
    });

    // add performance alarms
    this.addDBClusterPerformanceAlarms(dbCluster, dbClusterName, alarmAction);

    return {
      dbCluster,
      dbCreds: { username: dbUsername, password: dbPasswordSecret },
    };
  }

  private setupFargateService(
    props: FHIRServerProps,
    dbCluster: rds.IDatabaseCluster,
    dbCreds: { username: string; password: secret.Secret },
    alarmAction?: SnsAction
  ): FargateService {
    const {
      taskCountMin,
      taskCountMax,
      cpu,
      memoryLimitMiB,
      maxExecutionTimeout,
      listenToPort,
    } = settings();

    // Create a new Amazon Elastic Container Service (ECS) cluster
    const cluster = new ecs.Cluster(this, "FHIRServerCluster", {
      vpc: this.vpc,
      containerInsights: true,
    });

    const dockerImage = new ecr_assets.DockerImageAsset(this, "FHIRImage", {
      directory: "../",
    });

    // Prep DB related data to the server
    if (!dbCreds.password) throw new Error(`Missing DB password`);
    const dbAddress = dbCluster.clusterEndpoint.hostname;
    const dbPort = dbCluster.clusterEndpoint.port;
    const dbName = props.config.dbName;
    const dbUrl = `jdbc:postgresql://${dbAddress}:${dbPort}/${dbName}`;

    // Run some servers on fargate containers
    const fargateService =
      new ecs_patterns.ApplicationLoadBalancedFargateService(
        this,
        "FHIRServerFargateService",
        {
          cluster: cluster,
          cpu,
          memoryLimitMiB,
          desiredCount: taskCountMin,
          taskImageOptions: {
            image: ecs.ContainerImage.fromDockerImageAsset(dockerImage),
            containerPort: listenToPort,
            containerName: "FHIR-Server",
            secrets: {
              DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCreds.password),
            },
            environment: {
              SPRING_PROFILES_ACTIVE: props.config.environmentType,
              DB_URL: dbUrl,
              DB_USERNAME: dbCreds.username,
            },
          },
          healthCheckGracePeriod: Duration.seconds(120),
          publicLoadBalancer: false,
          idleTimeout: maxExecutionTimeout,
          runtimePlatform: {
            cpuArchitecture: ecs.CpuArchitecture.ARM64,
            operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          },
        }
      );

    // This speeds up deployments so the tasks are swapped quicker.
    // See for details: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html#deregistration-delay
    fargateService.targetGroup.setAttribute(
      "deregistration_delay.timeout_seconds",
      "17"
    );

    // This also speeds up deployments so the health checks have a faster turnaround.
    // See for details: https://docs.aws.amazon.com/elasticloadbalancing/latest/network/target-group-health-checks.html
    fargateService.targetGroup.configureHealthCheck({
      healthyThresholdCount: 2,
      interval: Duration.seconds(30),
      path: "/",
      port: `${listenToPort}`,
      protocol: Protocol.HTTP,
    });

    // CloudWatch Alarms and Notifications
    const fargateCPUAlarm = fargateService.service
      .metricCpuUtilization()
      .createAlarm(this, "FHIRCPUAlarm", {
        threshold: 80,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    alarmAction && fargateCPUAlarm.addAlarmAction(alarmAction);
    alarmAction && fargateCPUAlarm.addOkAction(alarmAction);

    const fargateMemoryAlarm = fargateService.service
      .metricMemoryUtilization()
      .createAlarm(this, "FHIRMemoryAlarm", {
        threshold: 70,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    alarmAction && fargateMemoryAlarm.addAlarmAction(alarmAction);
    alarmAction && fargateMemoryAlarm.addOkAction(alarmAction);

    // Access grant for Aurora DB
    dbCreds.password.grantRead(fargateService.taskDefinition.taskRole);
    dbCluster.connections.allowDefaultPortFrom(fargateService.service);

    // hookup autoscaling based on 90% thresholds
    const scaling = fargateService.service.autoScaleTaskCount({
      minCapacity: taskCountMin,
      maxCapacity: taskCountMax,
    });
    scaling.scaleOnCpuUtilization("autoscale_cpu", {
      targetUtilizationPercent: 90,
      scaleInCooldown: Duration.minutes(2),
      scaleOutCooldown: Duration.seconds(30),
    });
    scaling.scaleOnMemoryUtilization("autoscale_mem", {
      targetUtilizationPercent: 90,
      scaleInCooldown: Duration.minutes(2),
      scaleOutCooldown: Duration.seconds(30),
    });

    // allow the NLB to talk to fargate
    fargateService.service.connections.allowFrom(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      "Allow traffic from within the VPC to the service secure port"
    );

    // Add internal subdomain for the server
    new r53.ARecord(this, "FHIRServerRecord", {
      recordName: `${props.config.subdomain}.${props.config.domain}`,
      zone: this.zone,
      target: r53.RecordTarget.fromAlias(
        new r53_targets.LoadBalancerTarget(fargateService.loadBalancer)
      ),
    });

    return fargateService.service;
  }

  // TODO REVIEW THESE THRESHOLDS
  private addDBClusterPerformanceAlarms(
    dbCluster: rds.DatabaseCluster,
    dbClusterName: string,
    alarmAction?: SnsAction
  ) {
    const memoryMetric = dbCluster.metricFreeableMemory();
    const memoryAlarm = memoryMetric.createAlarm(
      this,
      `${dbClusterName}FreeableMemoryAlarm`,
      {
        threshold: mbToBytes(150),
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    alarmAction && memoryAlarm.addAlarmAction(alarmAction);
    alarmAction && memoryAlarm.addOkAction(alarmAction);

    const storageMetric = dbCluster.metricFreeLocalStorage();
    const storageAlarm = storageMetric.createAlarm(
      this,
      `${dbClusterName}FreeLocalStorageAlarm`,
      {
        threshold: mbToBytes(250),
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    alarmAction && storageAlarm.addAlarmAction(alarmAction);
    alarmAction && storageAlarm.addOkAction(alarmAction);

    const cpuMetric = dbCluster.metricCPUUtilization();
    const cpuAlarm = cpuMetric.createAlarm(
      this,
      `${dbClusterName}CPUUtilizationAlarm`,
      {
        threshold: 90, // percentage
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    alarmAction && cpuAlarm.addAlarmAction(alarmAction);
    alarmAction && cpuAlarm.addOkAction(alarmAction);

    const readIOPsMetric = dbCluster.metricVolumeReadIOPs();
    const readAlarm = readIOPsMetric.createAlarm(
      this,
      `${dbClusterName}VolumeReadIOPsAlarm`,
      {
        threshold: 20000, // IOPs per second
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    alarmAction && readAlarm.addAlarmAction(alarmAction);
    alarmAction && readAlarm.addOkAction(alarmAction);

    const writeIOPsMetric = dbCluster.metricVolumeWriteIOPs();
    const writeAlarm = writeIOPsMetric.createAlarm(
      this,
      `${dbClusterName}VolumeWriteIOPsAlarm`,
      {
        threshold: 5000, // IOPs per second
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    alarmAction && writeAlarm.addAlarmAction(alarmAction);
    alarmAction && writeAlarm.addOkAction(alarmAction);
  }

  private isProd(props: FHIRServerProps): boolean {
    return isProd(props.config);
  }
}

function setupSlackNotifSnsTopic(
  stack: Stack,
  config: EnvConfig
): { snsTopic: ITopic; alarmAction: SnsAction } | undefined {
  if (!config.slack) return undefined;
  const slackNotifSnsTopic = sns.Topic.fromTopicArn(
    stack,
    "SlackSnsTopic",
    config.slack.snsTopicArn
  );
  const alarmAction = new SnsAction(slackNotifSnsTopic);
  return { snsTopic: slackNotifSnsTopic, alarmAction };
}
