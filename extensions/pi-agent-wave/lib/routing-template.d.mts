export declare const DELEGATE_GRAPH_ROLES: readonly string[];
export declare const REQUIRED_TIERS: readonly string[];
export declare const OPTIONAL_TIERS: readonly string[];
export declare const TIER_DEFAULTS: Readonly<Record<string, { thinking: string; session: boolean; label: string }>>;
export declare const ROLE_TIERS: Readonly<Record<string, string>>;
export declare const ROLE_CAPABILITY_FLOORS: Readonly<Record<string, string>>;
export declare const CAPABILITY_FLOORS: Readonly<Record<string, string>>;

export interface RoutingTemplateOptions {
  chains?: Record<string, string[]>;
  includeLocalFast?: boolean;
}

export declare function generateRoutingTemplate(options?: RoutingTemplateOptions): string;
