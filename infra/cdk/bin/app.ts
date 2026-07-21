import { App } from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack.js";
import { SecretsStack } from "../lib/secrets-stack.js";
import { GeneratorStack } from "../lib/generator-stack.js";
import { WorkerStack } from "../lib/worker-stack.js";
import { AlertsStack } from "../lib/alerts-stack.js";

const app = new App();

// Deploys into your own AWS account: `cdk deploy` picks this up from the
// active credentials (CDK_DEFAULT_ACCOUNT) or an explicit AWS_ACCOUNT_ID.
const account = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID;
if (!account) {
  throw new Error(
    "No AWS account resolved. Authenticate (so CDK_DEFAULT_ACCOUNT is set) or export AWS_ACCOUNT_ID.",
  );
}

// Home region: holds the generator (active + standby), the secret writer, and
// alerts. Workers live in every region in WORKER_REGIONS. Workers outside the
// home region connect to Neon over the public endpoint (works fine across
// AWS regions for our write volume).
const HOME_REGION = "us-east-2" as const;
const WORKER_REGIONS = ["us-east-2", "eu-central-1", "ap-northeast-1"] as const;

const secrets = new SecretsStack(app, "RpcBenchSecrets", {
  env: { account, region: HOME_REGION },
});

const homeWorkerServices: WorkerStack["service"][] = [];
let generatorService: GeneratorStack["service"] | null = null;

for (const region of WORKER_REGIONS) {
  const env = { account, region };

  const network = new NetworkStack(app, `RpcBenchNetwork-${region}`, { env });

  const workerA = new WorkerStack(app, `RpcBenchWorkerA-${region}`, {
    env,
    vpc: network.vpc,
    cluster: network.cluster,
    secret: secrets.secret,
    egressPath: "aws-nat-a",
    region,
    natSubnetIds: network.natASubnetIds,
  });

  const workerB = new WorkerStack(app, `RpcBenchWorkerB-${region}`, {
    env,
    vpc: network.vpc,
    cluster: network.cluster,
    secret: secrets.secret,
    egressPath: "aws-nat-b",
    region,
    natSubnetIds: network.natBSubnetIds,
  });

  if (region === HOME_REGION) {
    const generator = new GeneratorStack(app, "RpcBenchGenerator", {
      env,
      vpc: network.vpc,
      cluster: network.cluster,
      secret: secrets.secret,
    });
    generatorService = generator.service;
    homeWorkerServices.push(workerA.service, workerB.service);
  }
}

if (generatorService) {
  // Alerts on the home-region services only. Cross-region CloudWatch alarms
  // are possible but add stack-coupling we don't need at v1; non-home regions
  // are silent for paging until we wire per-region alerts.
  new AlertsStack(app, "RpcBenchAlerts", {
    env: { account, region: HOME_REGION },
    generatorService,
    workerServices: homeWorkerServices,
  });
}
