import { Stack, type StackProps } from "aws-cdk-lib";
import {
  type Vpc,
  SubnetSelection,
  SecurityGroup,
  Subnet,
} from "aws-cdk-lib/aws-ec2";
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

interface WorkerStackProps extends StackProps {
  vpc: Vpc;
  cluster: Cluster;
  secret: Secret;
  egressPath: string;
  region: string;
  natSubnetIds: string[];
}

/**
 * One worker service per (region × egress path). The natSubnetIds force the
 * service onto the subnets that route through a specific NAT gateway, so each
 * service has a deterministic outbound EIP.
 */
export class WorkerStack extends Stack {
  public readonly service: FargateService;

  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);

    const taskDef = new FargateTaskDefinition(this, "WorkerTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    taskDef.addContainer("worker", {
      // platform: LINUX_AMD64 forces the build to produce an x86_64 image
      // regardless of host arch. Fargate defaults to x86_64; without this,
      // builds on Apple Silicon produce arm64 images that crash with
      // "exec format error" inside the task.
      image: ContainerImage.fromAsset("../../", {
        file: "apps/worker/Dockerfile",
        platform: Platform.LINUX_AMD64,
      }),
      logging: LogDrivers.awsLogs({
        streamPrefix: `worker-${props.egressPath}`,
        logGroup: new LogGroup(this, "WorkerLogs", { retention: RetentionDays.ONE_MONTH }),
      }),
      environment: {
        WORKER_REGION: props.region,
        WORKER_EGRESS_PATH: props.egressPath,
      },
      secrets: secretEnv(props.secret, [
        "NEON_DATABASE_URL_POOLED",
        "NEON_DATABASE_URL_DIRECT",
        "HELIUS_API_KEY",
        "HELIUS_GATEKEEPER_URL",
        "TRITON_URL",
        "ALCHEMY_URL",
        "QUICKNODE_URL",
      ]),
    });

    const sg = new SecurityGroup(this, "WorkerSg", { vpc: props.vpc, allowAllOutbound: true });
    const subnets: SubnetSelection = {
      subnets: props.natSubnetIds.map((id, i) =>
        Subnet.fromSubnetId(this, `WorkerSubnet${i}`, id),
      ),
    };

    this.service = new FargateService(this, "WorkerSvc", {
      cluster: props.cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      vpcSubnets: subnets,
      securityGroups: [sg],
      enableExecuteCommand: true,
    });
  }
}

function secretEnv(s: Secret, keys: string[]): Record<string, EcsSecret> {
  const out: Record<string, EcsSecret> = {};
  for (const k of keys) out[k] = EcsSecret.fromSecretsManager(s, k);
  return out;
}
