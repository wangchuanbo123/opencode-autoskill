import { type ReviewerConfig } from "./reviewer.js";
export type PortableHost = "opencode" | "claude-code" | "codex" | "gemini" | "cursor" | "generic";
export declare const portableHosts: PortableHost[];
export interface PortableConfig {
    schemaVersion: 1;
    adapters: Partial<Record<PortableHost, {
        enabled: boolean;
        mode?: "native" | "mcp" | "hooks";
        capabilities?: string[];
    }>>;
    options: Record<string, unknown>;
    reviewer?: ReviewerConfig;
    agentPolicy: "root-only" | "inherit" | "independent";
}
export declare const defaultPortableConfig: () => PortableConfig;
export declare function normalizeHost(value: string): PortableHost;
export declare function sha256(value: string | Buffer): string;
export declare function readSafeFile(file: string, max?: number): Promise<string | undefined>;
/** Check every existing ancestor, including junctions, before touching a host configuration. */
export declare function assertSafePath(file: string): Promise<void>;
export declare function writeSafeFile(file: string, content: string | Buffer, expected?: string | null, maxExistingBytes?: number): Promise<void>;
export declare function withPortableLock<T>(root: string, name: string, operation: () => Promise<T>): Promise<T>;
/** Runtime receipts and configuration backups can contain private host data. */
export declare function ensurePortablePrivate(root: string): Promise<void>;
export declare function parseObject(text: string, label: string): Record<string, any>;
export declare function readPortableConfig(root: string): Promise<PortableConfig>;
export declare function hasLegacyData(root: string): Promise<boolean>;
export declare function portableCommand(root: string, host: PortableHost, command: "hook" | "serve", event?: string, packageDir?: string): string;
interface OwnedChange {
    file: string;
    key?: (string | number)[];
    kind: "field" | "array" | "toml";
    installed: any;
    before?: any;
    beforePresent?: boolean;
    hash: string;
}
export interface InstallationContribution {
    file: string;
    key?: (string | number)[];
    kind: OwnedChange["kind"];
    state: "present" | "missing" | "modified" | "invalid";
    reason?: string;
}
/** Inspect actual owned fields rather than treating an installation receipt as proof. */
export declare function inspectHostInstallation(root: string, host: PortableHost): Promise<{
    recorded: boolean;
    installed: boolean;
    state: "not-recorded" | "inactive" | "intact" | "missing" | "drifted";
    repairable: boolean;
    contributions: InstallationContribution[];
}>;
/** Explicit portable OpenCode commands also update the existing neutral override. */
export declare function withNativeAdapterUpdate<T>(root: string, enabled: boolean, dryRun: boolean, operation: () => Promise<T>): Promise<{
    result: T;
    neutralAdapter?: {
        changed: boolean;
        enabled: boolean;
        dryRun: boolean;
    };
}>;
export interface InstallHostOptions {
    root: string;
    host: PortableHost;
    action?: "install" | "uninstall" | "enable" | "disable";
    packageDir?: string;
    dryRun?: boolean;
}
/** Apply only owned leaf fields/array entries; unrelated host configuration survives uninstall. */
export declare function installHost(input: InstallHostOptions): Promise<Record<string, unknown>>;
export {};
