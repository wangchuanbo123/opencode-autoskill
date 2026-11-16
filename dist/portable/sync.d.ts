import { type PortableHost } from "./install.js";
export declare function syncNativeSkills(input: {
    root: string;
    host: PortableHost;
    prune?: boolean;
    dryRun?: boolean;
}): Promise<Record<string, unknown>>;
