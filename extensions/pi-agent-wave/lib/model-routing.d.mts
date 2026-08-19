export interface ResolvedModelRoute {
  tier: string;
  warning: string | null;
  models: string[];
  thinking: string;
  session: boolean;
  primary: string;
}

export function resolveModel(config: any, key: string, mode?: string): ResolvedModelRoute;
