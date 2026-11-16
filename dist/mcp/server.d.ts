import type { PortableRuntime } from "../portable/runtime.js";
type Json = Record<string, unknown>;
export declare const MCP_TOOLS: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: Json;
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        readOnlyHint: boolean;
        openWorldHint: boolean;
        destructiveHint?: undefined;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: Json;
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        destructiveHint: boolean;
        openWorldHint: boolean;
        readOnlyHint?: undefined;
    };
})[];
export declare function callMcpTool(runtime: PortableRuntime, name: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
/** MCP stdio uses newline-delimited JSON-RPC. Nothing except protocol data goes to stdout. */
export declare function serveMcp(runtime: PortableRuntime, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): Promise<void>;
export {};
