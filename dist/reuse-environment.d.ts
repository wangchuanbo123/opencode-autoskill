import type { ReuseEnvironment } from "./retrieval.js";
/** Read only bounded project manifests; no shell, home search, environment values or recursive scan. */
export declare function detectReuseEnvironment(root: string, signal?: AbortSignal): Promise<ReuseEnvironment>;
