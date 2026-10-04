export type HostServicePlatform = "darwin" | "linux" | "win32";

export interface HostServiceCommand {
	readonly executable: string;
	readonly args: readonly string[];
}

export interface HostService {
	readonly name: string;
	readonly description: string;
	readonly start: Partial<Record<HostServicePlatform, HostServiceCommand>>;
	readonly env: Readonly<Record<string, string>>;
	readonly readyTimeoutSeconds: number;
}

/** One service resolved for the dispatching platform; the shape `delegate_core.py start --host-services-json` reads. */
export interface AttachedHostService extends HostServiceCommand {
	readonly name: string;
	readonly description: string;
	readonly env: Readonly<Record<string, string>>;
	readonly readyTimeoutSeconds: number;
}

export declare const HOST_SERVICES_FILENAME: "host-services.jsonc";
export declare const HOST_SERVICE_PLATFORMS: readonly HostServicePlatform[];
export declare function resolveHostServicesPath(agentDir: string): string;
export declare function parseHostServices(document: unknown): HostService[];
export declare function loadHostServices(path: string): HostService[];
export declare function attachHostServices(services: readonly HostService[], names: readonly string[], platform?: string): AttachedHostService[];
