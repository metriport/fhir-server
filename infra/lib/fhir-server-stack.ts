import { Aspects, CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { InstanceType } from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as rds from "aws-cdk-lib/aws-rds";
import { Credentials } from "aws-cdk-lib/aws-rds";
import * as r53 from "aws-cdk-lib/aws-route53";
import * as r53_targets from "aws-cdk-lib/aws-route53-targets";
import * as secret from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { EnvConfig } from "./env-config";
import { isProd, mbToBytes } from "./util";

interface FHIRServerProps extends StackProps {
  config: EnvConfig;
}

// TODO Consider moving infra parameters to the configuration files (EnvConfig)
export class FHIRServerStack extends Stack {
  constructor(scope: Construct, id: string, props: FHIRServerProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "APIVpc", {
      vpcId: props.config.vpcId,
    });

    //-------------------------------------------
    // Aurora Database
    //-------------------------------------------
    const { dbCluster, dbCreds } = this.setupDB(props, vpc);

    //-------------------------------------------
    // ECS + Fargate for FHIR Server
    //-------------------------------------------
    const fargateService = this.setupFargateService(
      props,
      vpc,
      dbCluster,
      dbCreds
    );

    this.setupNetworking(props, vpc, fargateService);

    //-------------------------------------------
    // Output
    //-------------------------------------------
    new CfnOutput(this, "FargateServiceARN", {
      description: "Fargate Service ARN",
      value: fargateService.service.serviceArn,
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
    vpc: ec2.IVpc
  ): {
    dbCluster: rds.IDatabaseCluster;
    dbCreds: { username: string; password: secret.Secret };
  } {
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
      instanceProps: { vpc, instanceType: new InstanceType("serverless") },
      credentials: dbCreds,
      defaultDatabaseName: dbName,
      clusterIdentifier: dbClusterName,
      storageEncrypted: true,
    });

    const minDBCap = this.isProd(props) ? 2 : 1;
    const maxDBCap = this.isProd(props) ? 8 : 2;
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

    // add performance alarms for monitoring prod environment
    if (this.isProd(props)) {
      this.addDBClusterPerformanceAlarms(dbCluster, dbClusterName);
    }
    return {
      dbCluster,
      dbCreds: { username: dbUsername, password: dbPasswordSecret },
    };
  }

  private setupFargateService(
    props: FHIRServerProps,
    vpc: ec2.IVpc,
    dbCluster: rds.IDatabaseCluster,
    dbCreds: { username: string; password: secret.Secret }
  ): ecs_patterns.NetworkLoadBalancedFargateService {
    // Create a new Amazon Elastic Container Service (ECS) cluster
    const cluster = new ecs.Cluster(this, "FHIRServerCluster", { vpc });

    // Retrieve a Docker image from Amazon Elastic Container Registry (ECR)
    // const dockerImage = ecs.EcrImage.fromRegistry(props.config.fhirServerECRName);
    // const dockerImage = ecs.ContainerImage.fromRegistry(props.config.fhirServerECRName);
    const dockerImage = ecs.ContainerImage.fromEcrRepository(
      ecr.Repository.fromRepositoryName(
        this,
        "FHIRServerECR",
        props.config.fhirServerECRName
      )
    );

    // Prep DB related data to the server
    if (!dbCreds.password) throw new Error(`Missing DB password`);
    const dbAddress = dbCluster.clusterEndpoint.hostname;
    const dbPort = dbCluster.clusterEndpoint.port;
    // const dbSchema = props.config.dbName;
    // const dbUrl = `jdbc:postgresql://${dbAddress}:${dbPort}/${props.config.dbName}?currentSchema=${dbSchema}`;
    const dbName = props.config.dbName;
    const dbUrl = `jdbc:postgresql://${dbAddress}:${dbPort}/${dbName}`;

    // Run some servers on fargate containers
    const fargateService = new ecs_patterns.NetworkLoadBalancedFargateService(
      this,
      "FHIRServerFargateService",
      {
        cluster: cluster,
        cpu: this.isProd(props) ? 2048 : 1024,
        memoryLimitMiB: this.isProd(props) ? 4096 : 2048,
        desiredCount: this.isProd(props) ? 1 : 1, // TODO review once we go live
        taskImageOptions: {
          image: dockerImage,
          containerPort: 8080,
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
        healthCheckGracePeriod: Duration.seconds(60),
        publicLoadBalancer: false,
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
      interval: Duration.seconds(10),
    });

    // Access grant for Aurora DB
    dbCreds.password.grantRead(fargateService.taskDefinition.taskRole);
    dbCluster.connections.allowDefaultPortFrom(fargateService.service);

    // hookup autoscaling based on 90% thresholds
    const scaling = fargateService.service.autoScaleTaskCount({
      minCapacity: this.isProd(props) ? 2 : 1,
      maxCapacity: this.isProd(props) ? 10 : 2,
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
    return fargateService;
  }

  private setupNetworking(
    props: FHIRServerProps,
    vpc: ec2.IVpc,
    fargateService: ecs_patterns.NetworkLoadBalancedFargateService
  ): void {
    // allow the NLB to talk to fargate
    fargateService.service.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      "Allow traffic from within the VPC to the service secure port"
    );

    // // setup a private link so the API can talk to the NLB
    // const link = new apig.VpcLink(this, "link", {
    //   targets: [fargateService.loadBalancer],
    // });

    // const fhirServerAddress = fargateService.loadBalancer.loadBalancerDnsName;
    // const integration = new apig.Integration({
    //   type: apig.IntegrationType.HTTP_PROXY,
    //   options: {
    //     connectionType: apig.ConnectionType.VPC_LINK,
    //     vpcLink: link,
    //     requestParameters: {
    //       "integration.request.path.proxy": "method.request.path.proxy",
    //     },
    //   },
    //   integrationHttpMethod: "ANY",
    //   uri: `http://${fhirServerAddress}/{proxy}`,
    // });

    const zone = r53.HostedZone.fromLookup(this, "Zone", {
      domainName: props.config.zone,
      privateZone: true,
    });
    const serverUrl = `${props.config.subdomain}.${props.config.domain}`;
    new r53.ARecord(this, "FHIRServerRecord", {
      recordName: serverUrl,
      zone,
      target: r53.RecordTarget.fromAlias(new r53_targets.LoadBalancerTarget(fargateService.loadBalancer)),
    });
  }

  // TODO REVIEW THESE THRESHOLDS
  // TODO REVIEW THESE THRESHOLDS
  // TODO REVIEW THESE THRESHOLDS
  private addDBClusterPerformanceAlarms(
    dbCluster: rds.DatabaseCluster,
    dbClusterName: string
  ) {
    const memoryMetric = dbCluster.metricFreeableMemory();
    memoryMetric.createAlarm(this, `${dbClusterName}FreeableMemoryAlarm`, {
      threshold: mbToBytes(150),
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    const storageMetric = dbCluster.metricFreeLocalStorage();
    storageMetric.createAlarm(this, `${dbClusterName}FreeLocalStorageAlarm`, {
      threshold: mbToBytes(250),
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    const cpuMetric = dbCluster.metricCPUUtilization();
    cpuMetric.createAlarm(this, `${dbClusterName}CPUUtilizationAlarm`, {
      threshold: 90, // percentage
      evaluationPeriods: 1,
    });

    const readIOPsMetric = dbCluster.metricVolumeReadIOPs();
    readIOPsMetric.createAlarm(this, `${dbClusterName}VolumeReadIOPsAlarm`, {
      threshold: 20000, // IOPs per second
      evaluationPeriods: 1,
    });

    const writeIOPsMetric = dbCluster.metricVolumeWriteIOPs();
    writeIOPsMetric.createAlarm(this, `${dbClusterName}VolumeWriteIOPsAlarm`, {
      threshold: 5000, // IOPs per second
      evaluationPeriods: 1,
    });
  }

  private isProd(props: FHIRServerProps): boolean {
    return isProd(props.config);
  }
}
