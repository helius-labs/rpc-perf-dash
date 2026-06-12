import { Stack, type StackProps } from "aws-cdk-lib";
import {
  Vpc,
  SubnetType,
  IpAddresses,
  type ISubnet,
} from "aws-cdk-lib/aws-ec2";
import { Cluster } from "aws-cdk-lib/aws-ecs";
import type { Construct } from "constructs";

/**
 * VPC with two NAT gateways in two AZs (different EIPs) so workers can use
 * distinct egress paths per the multi-cloud-egress requirement.
 *
 * Hetzner shadow worker is provisioned outside CDK (separate cloud account).
 */
export class NetworkStack extends Stack {
  public readonly vpc: Vpc;
  public readonly cluster: Cluster;
  public readonly natASubnetIds: string[];
  public readonly natBSubnetIds: string[];

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, "Vpc", {
      ipAddresses: IpAddresses.cidr("10.42.0.0/16"),
      maxAzs: 2,
      natGateways: 2,
      subnetConfiguration: [
        { name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      ],
    });

    this.cluster = new Cluster(this, "Cluster", { vpc: this.vpc });

    const privateSubnets = this.vpc.privateSubnets;
    this.natASubnetIds = subnetsForAz(privateSubnets, 0);
    this.natBSubnetIds = subnetsForAz(privateSubnets, 1);
  }
}

function subnetsForAz(subnets: ISubnet[], idx: number): string[] {
  const az = subnets[idx]?.availabilityZone;
  return subnets.filter((s) => s.availabilityZone === az).map((s) => s.subnetId);
}
