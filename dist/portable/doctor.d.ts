import { type PortableHost } from "./install.js";
export declare function doctorHost(input: {
    root: string;
    host: PortableHost;
    binary?: string;
}): Promise<Record<string, unknown>>;
