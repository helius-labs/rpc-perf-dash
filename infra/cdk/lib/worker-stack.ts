import { Stack, type StackProps } from "aws-cdk-lib";
import {
  type Vpc,
  SubnetSelection,
  SecurityGroup,
  Subnet,
} from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
} from "aws-cdk-lib/aws-ecs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { secretEnv, linuxAmd64Image, NEON_SECRET_KEYS, PANEL_SECRET_KEYS } from "./util.js";

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
      image: linuxAmd64Image("apps/worker/Dockerfile"),
      logging: LogDrivers.awsLogs({
        streamPrefix: `worker-${props.egressPath}`,
        logGroup: new LogGroup(this, "WorkerLogs", { retention: RetentionDays.ONE_MONTH }),
      }),
      environment: {
        WORKER_REGION: props.region,
        WORKER_EGRESS_PATH: props.egressPath,
      },
      // Workers call the panel directly; no utility/auditor keys (the
      // auditor-independence assertion runs generator-side only).
      secrets: secretEnv(props.secret, [...NEON_SECRET_KEYS, ...PANEL_SECRET_KEYS]),
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
