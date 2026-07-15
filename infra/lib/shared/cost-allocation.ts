import { Tags } from "aws-cdk-lib";
import { IConstruct } from "constructs";
import { EnvType } from "../env-type";

const costAllocationTagKeys = {
  domain: "domain",
  capability: "capability",
  component: "component",
  deployableUnit: "deployable-unit",
  env: "env",
} as const;

export type CostAllocationTags = {
  domain: string;
  capability: string;
  component: string;
  deployableUnit: string;
  env: EnvType;
};

export function applyCostAllocationTags(
  scope: IConstruct,
  tags: CostAllocationTags
): void {
  const resourceTags = Tags.of(scope);
  resourceTags.add(costAllocationTagKeys.domain, tags.domain);
  resourceTags.add(costAllocationTagKeys.capability, tags.capability);
  resourceTags.add(costAllocationTagKeys.component, tags.component);
  resourceTags.add(costAllocationTagKeys.deployableUnit, tags.deployableUnit);
  resourceTags.add(costAllocationTagKeys.env, tags.env);
}

export function applyComponentTag(scope: IConstruct, component: string): void {
  Tags.of(scope).add(costAllocationTagKeys.component, component);
}
