import { Duration, Stack, StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { FargateService } from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import { Protocol } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";
import { EnvConfig } from "./env-config";
import { getConfig } from "./shared/config";
import { vCPU } from "./shared/fargate";
import { setupSlackNotifSnsTopic } from "./shared/slack-notifications";
import { addDefaultMetricsToTargetGroup } from "./shared/target-group";
import { isProd, isSandbox } from "./util";

type ValidateSettings = {
  cpu: number;
  memoryLimitMiB: number;
  taskCountMin: number;
  taskCountMax: number;
  maxExecutionTimeout: Duration;
  listenToPort: number;
};

function validateSettings(): ValidateSettings {
  const config = getConfig();
  const defaults = {
    maxExecutionTimeout: Duration.minutes(15),
    listenToPort: 8080,
  };
  if (isProd(config)) {
    return {
      ...defaults,
      cpu: 4 * vCPU,
      memoryLimitMiB: 4096,
      taskCountMin: 2,
      taskCountMax: 20,
    };
  }
  if (isSandbox(config)) {
    return {
      ...defaults,
      cpu: 1 * vCPU,
      memoryLimitMiB: 2048,
      taskCountMin: 1,
      taskCountMax: 4,
    };
  }
  return {
    ...defaults,
    cpu: 1 * vCPU,
    memoryLimitMiB: 2048,
    taskCountMin: 1,
    taskCountMax: 4,
  };
}

interface FhirValidateServerProps extends StackProps {
  config: EnvConfig;
}

/**
 * Validate-only FHIR pool: same Docker image, {@code validate} Spring profile (in-memory H2).
 */
export class FhirValidateServerStack extends Stack {
  readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: FhirValidateServerProps) {
    super(scope, id, props);

    this.vpc = ec2.Vpc.fromLookup(this, "APIVpc", {
      vpcId: props.config.vpcId,
    });

    const slackNotification = setupSlackNotifSnsTopic(this, props.config);
    this.setupFargateService(slackNotification?.alarmAction);
  }

  private setupFargateService(alarmAction?: SnsAction): FargateService {
    const {
      taskCountMin,
      taskCountMax,
      cpu,
      memoryLimitMiB,
      maxExecutionTimeout,
      listenToPort,
    } = validateSettings();

    const cluster = new ecs.Cluster(this, "FHIRValidateCluster", {
      vpc: this.vpc,
      containerInsights: true,
    });

    const dockerImage = new ecr_assets.DockerImageAsset(this, "FHIRValidateImage", {
      directory: "../",
    });

    const fargateService =
      new ecs_patterns.ApplicationLoadBalancedFargateService(
        this,
        "FHIRValidateFargateService",
        {
          cluster,
          cpu,
          memoryLimitMiB,
          desiredCount: taskCountMin,
          taskImageOptions: {
            image: ecs.ContainerImage.fromDockerImageAsset(dockerImage),
            containerPort: listenToPort,
            containerName: "FHIR-Validate",
            environment: {
              SPRING_PROFILES_ACTIVE: "validate",
            },
          },
          healthCheckGracePeriod: Duration.seconds(180),
          publicLoadBalancer: false,
          idleTimeout: maxExecutionTimeout,
          runtimePlatform: {
            cpuArchitecture: ecs.CpuArchitecture.X86_64,
            operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          },
        }
      );

    fargateService.targetGroup.setAttribute(
      "deregistration_delay.timeout_seconds",
      "17"
    );

    fargateService.targetGroup.configureHealthCheck({
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 4,
      interval: Duration.seconds(20),
      timeout: Duration.seconds(15),
      path: "/",
      port: `${listenToPort}`,
      protocol: Protocol.HTTP,
    });

    const fargateCPUAlarm = fargateService.service
      .metricCpuUtilization()
      .createAlarm(this, "FHIRValidateCPUAlarm", {
        threshold: 80,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    alarmAction && fargateCPUAlarm.addAlarmAction(alarmAction);
    alarmAction && fargateCPUAlarm.addOkAction(alarmAction);

    const fargateMemoryAlarm = fargateService.service
      .metricMemoryUtilization()
      .createAlarm(this, "FHIRValidateMemoryAlarm", {
        threshold: 70,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    alarmAction && fargateMemoryAlarm.addAlarmAction(alarmAction);
    alarmAction && fargateMemoryAlarm.addOkAction(alarmAction);

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

    addDefaultMetricsToTargetGroup({
      targetGroup: fargateService.targetGroup,
      scope: this,
      id: "FhirValidateServer",
      alarmAction,
    });

    // Internal ALB only; tighten to the API security group in metriport-private if desired.
    fargateService.service.connections.allowFrom(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(8080),
      "Allow VPC traffic to validate service"
    );

    return fargateService.service;
  }
}
