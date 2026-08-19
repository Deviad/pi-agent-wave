export interface BackupEntryInput {
  relativePath: string;
  path: string;
  existed?: boolean;
  bytes: Buffer | string;
  mode?: number;
}

export interface BackupEntry {
  relativePath: string;
  path: string;
  existed: boolean;
  mode: number;
  bytesBase64: string;
  sha256: string;
}

export declare function hashBytes(bytes: Buffer | Uint8Array): string;
export declare function hashFile(path: string): string | undefined;
export declare function writeExact(path: string, bytes: Buffer | Uint8Array | string, mode?: number): Promise<void>;
export declare function backupRoot(agentDir: string, id: string): string;
export declare function isValidBackupId(id: unknown): boolean;
export declare function defaultBackupId(now?: Date): string;
export declare function createBackup(options: { agentDir: string; id: string; entries: BackupEntryInput[] }): Promise<{ manifest: any; manifestPath: string; root: string }>;
export declare function finalizeBackup(manifestPath: string, status?: string): Promise<any>;
export declare function restoreBackup(manifestPath: string): Promise<{ manifest: any; restored: Array<{ relativePath: string; destination: string }> }>;
