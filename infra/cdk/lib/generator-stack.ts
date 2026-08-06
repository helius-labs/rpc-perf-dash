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
      // Generator-only: funds the per-(target × scenario) send wallets. Bound
      // unconditionally, so it must exist in rpcbench/env (`pnpm seed:aws`)
      // before ANY generator deploy — even a dark one. Only USED when
      // SENDS_ENABLED=true; harmless placeholder otherwise.
      "SEND_MASTER_KEYPAIR",
    ]);

    taskDef.addContainer("generator", {
      image: linuxAmd64Image("apps/generator/Dockerfile"),
      logging: LogDrivers.awsLogs({
        streamPrefix: "generator",
        logGroup: new LogGroup(this, "GeneratorLogs", {
          retention: RetentionDays.ONE_MONTH,
        }),
      }),
      // Sends config (non-secret). SENDS_ENABLED is a pass-through kill-switch,
      // default OFF — a deploy never emits send challenges or spends SOL unless
      // explicitly enabled: `SENDS_ENABLED=true cdk deploy RpcBenchGenerator`.
      // Scenarios default to all three; swap pool config is built into the code
      // (packages/send/scenarios/defaultPools.ts), so no per-cloud env needed.
      environment: {
        SENDS_ENABLED: process.env.SENDS_ENABLED ?? "false",
        SEND_SCENARIOS: process.env.SEND_SCENARIOS ?? "transfer,raydium_swap,orca_swap",
        SEND_TICK_INTERVAL_MS: process.env.SEND_TICK_INTERVAL_MS ?? "300000",
        SEND_MIN_BALANCE_LAMPORTS: process.env.SEND_MIN_BALANCE_LAMPORTS ?? "10000000",
        SEND_TOPUP_LAMPORTS: process.env.SEND_TOPUP_LAMPORTS ?? "20000000",
      },
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
