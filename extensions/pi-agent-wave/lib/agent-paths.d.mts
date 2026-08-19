export declare const ROUTING_FILENAME: "model-routing.jsonc";
export declare const CATALOG_FILENAME: "models.json";
export declare const FZF_FILENAME: "fzf.json";

export declare function resolveAgentDir(explicit?: string): string;
export declare function resolveRoutingPath(agentDir: string, explicit?: string): string;
export declare function resolveCatalogPath(agentDir: string, explicit?: string): string;
export declare function resolveFzfPath(agentDir: string): string;
