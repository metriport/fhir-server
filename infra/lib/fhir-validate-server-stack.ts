import { Duration, Stack, StackProps } from "aws-cdk-lib";
import { AdjustmentType } from "aws-cdk-lib/aws-applicationautoscaling";
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
      cpu: 2 * vCPU,
      memoryLimitMiB: 4096,
      taskCountMin: 4,
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

    const cpuMetric = fargateService.service.metricCpuUtilization({
      period: Duration.minutes(1),
    });

    // Step scale-out: +2 tasks when cluster CPU stays high (1 min metric periods).
    // If CPU is >= 70% for 3 of last 5 minutes, add 2 tasks.
    scaling.scaleOnMetric("autoscale_cpu_out", {
      metric: cpuMetric,
      adjustmentType: AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: Duration.minutes(1),
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      scalingSteps: [
        { lower: 70, change: +2 },
        { lower: 80, change: +2 },
      ],
    });

    // Step scale-in: remove tasks slowly when CPU is comfortably low.
    // If CPU is <= 45% for 5 of last 5 minutes, remove 1 task.
    scaling.scaleOnMetric("autoscale_cpu_in", {
      metric: cpuMetric,
      adjustmentType: AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: Duration.minutes(5),
      evaluationPeriods: 5,
      datapointsToAlarm: 5,
      scalingSteps: [
        { upper: 45, change: -1 },
        { upper: 25, change: -1 },
      ],
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
