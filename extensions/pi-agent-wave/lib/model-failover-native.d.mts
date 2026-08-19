export const MODEL_FAILOVER_RETRY: string;
export const MODEL_FAILOVER_TRANSPORT_RETRY: string;
export const MODEL_FAILOVER_BLOCKED: string;

export function parseFailoverRoute(raw: string): string[];
export function loadTierRoute(configFile: string, tier: string): string[];
export function classifyFailoverError(message: any, native?: any): any;
export function findNextFailoverCandidate(input: any): { model: any; index: number } | undefined;
export function sanitizeAssistantError(message: any, marker: string): any;
