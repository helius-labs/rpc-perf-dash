import { Stack, type StackProps } from "aws-cdk-lib";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

/**
 * Single Secrets Manager secret holding all env values workers + generator need.
 *
 * Real values are written manually into Secrets Manager after the first deploy
 * (see the placeholder seeding below). There is no automatic rotation — all
 * keys and connection strings are rotated on-demand.
 */
export class SecretsStack extends Stack {
  public readonly secret: Secret;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.secret = new Secret(this, "RpcBenchEnv", {
      secretName: "rpcbench/env",
      description: "RPC benchmark dashboard env (provider keys, Neon URLs, generator secret)",
      // Replicate to every worker region so worker tasks can read the secret
      // locally without a cross-region IAM role. Replication is one-way (home
      // region is the writer; updates propagate to replicas within ~30s).
      replicaRegions: [
        { region: "eu-central-1" },
        { region: "ap-northeast-1" },
      ],
      generateSecretString: {
        // "TODO" strings are placeholders only — they seed the secret's key
        // set at stack creation. Real values are written into Secrets
        // Manager after the first deploy and never live in this template.
        secretStringTemplate: JSON.stringify({
          NEON_DATABASE_URL_POOLED: "TODO",
          NEON_DATABASE_URL_DIRECT: "TODO",
          HELIUS_URL: "TODO",
          TRITON_URL: "TODO",
          ALCHEMY_URL: "TODO",
          QUICKNODE_URL: "TODO",
          CHAINSTACK_URL: "TODO",
          // Utility endpoint — the generator's chain-observation RPC
          // (challenge derivation, slot polling, honeypot seeding).
          UTILITY_RPC_URL: "TODO",
        }),
        generateStringKey: "GENERATOR_SECRET",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });
  }
}
