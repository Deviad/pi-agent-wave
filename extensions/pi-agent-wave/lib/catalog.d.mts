export declare const SENSITIVE_FIELDS: readonly string[];

export interface SelectableModel {
  provider: string;
  id: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
}

export interface CatalogAnalysis {
  selectable: SelectableModel[];
  problems: string[];
  byModelId: Map<string, SelectableModel>;
  providers: Record<string, any>;
}

export declare function loadCatalog(path: string): any;
export declare function analyzeCatalog(catalog: any): CatalogAnalysis;
export declare function listSelectableModels(catalog: any): SelectableModel[];
export declare function redactCatalog(value: any): any;
export declare function isLocalModel(modelId: string, models: any): boolean;
export declare function isLoopbackBaseUrl(baseUrl: unknown): boolean;
