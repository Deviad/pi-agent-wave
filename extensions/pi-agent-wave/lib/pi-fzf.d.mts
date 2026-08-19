export declare const FZF_COMMANDS: readonly string[];
export declare const FZF_FIELDS: readonly string[];

export interface PiFzfDetection {
  installed: boolean;
  reason?: string;
  settingsPath: string;
  packageEntry?: unknown;
}

export interface FzfMergeResult {
  parsed: any;
  bytes: Buffer;
  changed: boolean;
  collisions: Array<{ command: string; field: string; existing: string }>;
  changes: Array<{ command: string; field: string }>;
}

export declare function packageRoot(): string;
export declare function packageRoutePicker(): string;
export declare function shellQuote(value: unknown): string;
export declare function fzfCommandTargets(routePickerPath?: string): Record<string, { list: string; preview: string }>;
export declare function detectPiFzf(agentDir: string): PiFzfDetection;
export declare function mergeFzf(parsed: any, routePickerPath?: string): FzfMergeResult;
