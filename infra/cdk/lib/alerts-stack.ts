import { Stack, type StackProps, Duration } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { Topic } from "aws-cdk-lib/aws-sns";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import type { FargateService } from "aws-cdk-lib/aws-ecs";
import type { Construct } from "constructs";

interface AlertsStackProps extends StackProps {
  generatorService: FargateService;
  workerServices: FargateService[];
}

export class AlertsStack extends Stack {
  constructor(scope: Construct, id: string, props: AlertsStackProps) {
    super(scope, id, props);

    const topic = new Topic(this, "AlertsTopic", { displayName: "RPC Bench Alerts" });
    const action = new SnsAction(topic);

    // Pair each service with a stable, synth-time-known string ID. The service
    // itself can't be used directly in construct IDs because `serviceName` is a
    // CDK token (only resolved at deploy time).
    const services: Array<{ id: string; svc: FargateService }> = [
      { id: "Generator", svc: props.generatorService },
      ...props.workerServices.map((s, i) => ({ id: `Worker${i}`, svc: s })),
    ];

    for (const { id: sid, svc } of services) {
      const cpu = new Metric({
        namespace: "AWS/ECS",
        metricName: "CPUUtilization",
        dimensionsMap: {
          ClusterName: svc.cluster.clusterName,
          ServiceName: svc.serviceName,
        },
        period: Duration.minutes(5),
        statistic: "Average",
      });

      const running = new Metric({
        namespace: "ECS/ContainerInsights",
        metricName: "RunningTaskCount",
        dimensionsMap: {
          ClusterName: svc.cluster.clusterName,
          ServiceName: svc.serviceName,
        },
        period: Duration.minutes(1),
        statistic: "Minimum",
      });

      new Alarm(this, `${sid}HighCpu`, {
        metric: cpu,
        threshold: 90,
        evaluationPeriods: 3,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(action);

      new Alarm(this, `${sid}TaskShortfall`, {
        metric: running,
        threshold: 1,
        evaluationPeriods: 5,
        comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.BREACHING,
      }).addAlarmAction(action);
    }

    // Sample-rate-drop and stale-heartbeat alarms ride on Postgres data via a
    // dedicated Lambda + custom metrics — implemented in M7's Lambda (left as
    // a follow-up; the CW alarm wiring above covers the ECS-side health).
  }
}
