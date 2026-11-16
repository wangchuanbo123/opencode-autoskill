export type PortableHost = "opencode" | "claude-code" | "codex" | "gemini" | "cursor" | "generic";
export declare const portableHosts: PortableHost[];
export interface PortableConfig {
    schemaVersion: 1;
    adapters: Partial<Record<PortableHost, {
        enabled: boolean;
        mode?: "native" | "mcp" | "hooks";
    }>>;
    options: Record<string, unknown>;
    reviewer?: {
        type: "openai-compatible";
        baseUrl: string;
        model: string;
        apiKeyEnv?: string;
    };
    agentPolicy: "root-only" | "inherit" | "independent";
}
export declare const defaultPortableConfig: () => PortableConfig;
export declare function normalizeHost(value: string): PortableHost;
export declare function sha256(value: string | Buffer): string;
export declare function readSafeFile(file: string, max?: number): Promise<string | undefined>;
/** Check every existing ancestor, including junctions, before touching a host configuration. */
export declare function assertSafePath(file: string): Promise<void>;
export declare function writeSafeFile(file: string, content: string | Buffer, expected?: string | null): Promise<void>;
export declare function parseObject(text: string, label: string): Record<string, any>;
export declare function readPortableConfig(root: string): Promise<PortableConfig>;
export declare function hasLegacyData(root: string): Promise<boolean>;
export declare function portableCommand(root: string, host: PortableHost, command: "hook" | "serve", event?: string, packageDir?: string): string;
export interface InstallHostOptions {
    root: string;
    host: PortableHost;
    action?: "install" | "uninstall" | "enable" | "disable";
    packageDir?: string;
    dryRun?: boolean;
}
/** Apply only owned leaf fields/array entries; unrelated host configuration survives uninstall. */
export declare function installHost(input: InstallHostOptions): Promise<Record<string, unknown>>;
