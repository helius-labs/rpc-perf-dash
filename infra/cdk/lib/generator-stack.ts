import { Stack, type StackProps, Duration } from "aws-cdk-lib";
import type { Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  Secret as EcsSecret,
} from "aws-cdk-lib/aws-ecs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import type { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

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

    // 1 vCPU / 2GB. Smaller sizing lets the dispatch tick exceed its 25s
    // budget under load, which trips the no-challenges watchdog into
    // restarting the task. See docs/operations.md § Generator saturation.
    const taskDef = new FargateTaskDefinition(this, "GeneratorTask", {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    const secrets = secretEnv(props.secret, [
      "NEON_DATABASE_URL_POOLED",
      "NEON_DATABASE_URL_DIRECT",
      "GENERATOR_SECRET",
      // Benchmarked panel URLs. The generator never CALLS these — workers do —
      // but assertAuditorIndependent needs them resolvable in the generator's
      // env so the host-overlap check has something to compare against.
      // Removing any of these silently disables the auditor-independence
      // assertion for that provider.
      "HELIUS_API_KEY",
      "HELIUS_GATEKEEPER_URL",
      "TRITON_URL",
      "ALCHEMY_URL",
      "QUICKNODE_URL",
      // Independent auditor (utility) endpoint chain. Operator MUST be
      // panel-independent — see assertAuditorIndependent. The keys must be
      // present in the secret (empty string OK; resolveEndpointUrl filters
      // unset slots out at runtime) or the ECS secret reference fails to
      // start the task.
      "UTILITY_RPC_URL",
      "UTILITY_RPC_URL_2",
      "UTILITY_RPC_URL_3",
      // TEMPORARY: set to "1" in the secret while the auditor is pointed at
      // a panel-member host (a disclosed stopgap until an independent
      // auditor is provisioned — see docs/operations.md § Roadmap). Loud-warn
      // instead of fail.
      "AUDITOR_PANEL_OVERLAP_OK",
    ]);

    taskDef.addContainer("generator", {
      // platform: LINUX_AMD64 forces an x86_64 build regardless of host arch
      // (Apple Silicon → arm64 by default, which crashes on Fargate x86_64
      // tasks with "exec format error").
      image: ContainerImage.fromAsset("../../", {
        file: "apps/generator/Dockerfile",
        platform: Platform.LINUX_AMD64,
      }),
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

function secretEnv(s: Secret, keys: string[]): Record<string, EcsSecret> {
  const out: Record<string, EcsSecret> = {};
  for (const k of keys) out[k] = EcsSecret.fromSecretsManager(s, k);
  return out;
}
