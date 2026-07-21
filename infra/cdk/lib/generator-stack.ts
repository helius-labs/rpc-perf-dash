import { Stack, type StackProps, Duration } from "aws-cdk-lib";
import type { Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
} from "aws-cdk-lib/aws-ecs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { secretEnv, linuxAmd64Image, NEON_SECRET_KEYS } from "./util.js";

interface GeneratorStackProps extends StackProps {
  vpc: Vpc;
  cluster: Cluster;
  secret: Secret;
}

/**
 * Generator service — desiredCount=2 (active + hot standby via advisory lock).
 */
export class GeneratorStack extends Stack {
  public readonly service: FargateService;

  constructor(scope: Construct, id: string, props: GeneratorStackProps) {
    super(scope, id, props);

    // 1 vCPU / 2GB is the floor — don't size down. Anything smaller lets the
    // dispatch tick exceed its 25s budget under load, tripping the
    // no-challenges watchdog into restarting the task. See
    // docs/operations.md § Generator saturation.
    const taskDef = new FargateTaskDefinition(this, "GeneratorTask", {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    const secrets = secretEnv(props.secret, [
      ...NEON_SECRET_KEYS,
      "GENERATOR_SECRET",
      // Utility endpoint — the generator's chain-observation RPC (challenge
      // derivation, slot polling, honeypot seeding). Must be present in the
      // secret or the ECS secret reference fails to start the task.
      "UTILITY_RPC_URL",
    ]);

    taskDef.addContainer("generator", {
      image: linuxAmd64Image("apps/generator/Dockerfile"),
      logging: LogDrivers.awsLogs({
        streamPrefix: "generator",
        logGroup: new LogGroup(this, "GeneratorLogs", {
          retention: RetentionDays.ONE_MONTH,
        }),
      }),
      secrets,
    });

    this.service = new FargateService(this, "GeneratorSvc", {
      cluster: props.cluster,
      taskDefinition: taskDef,
      desiredCount: 2, // active + hot standby
      enableExecuteCommand: true,
      healthCheckGracePeriod: Duration.minutes(2),
    });
  }
}
