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
          HELIUS_API_KEY: "TODO",
          HELIUS_GATEKEEPER_URL: "TODO",
          TRITON_URL: "TODO",
          ALCHEMY_URL: "TODO",
          QUICKNODE_URL: "TODO",
          // Independent auditor (utility) endpoint chain. Operator MUST be
          // panel-independent — see assertAuditorIndependent in
          // packages/shared/src/providers.ts.
          UTILITY_RPC_URL: "TODO",
          UTILITY_RPC_URL_2: "",
          UTILITY_RPC_URL_3: "",
          // TEMPORARY override. Set to "1" only when the configured
          // UTILITY_RPC_URL points at a panel-member host (a disclosed
          // stopgap until an independent auditor is provisioned). Loud-warns
          // at startup instead of failing closed.
          AUDITOR_PANEL_OVERLAP_OK: "",
        }),
        generateStringKey: "GENERATOR_SECRET",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });
  }
}
