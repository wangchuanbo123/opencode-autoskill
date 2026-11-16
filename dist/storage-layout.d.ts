/** One project has one authoritative skill repository and private runtime. */
export interface StorageLayout {
    kind: "legacy" | "portable";
    root: string;
    skillsRoot: string;
    stateRoot: string;
    configFile: string;
}
export declare function createLegacyStorageLayout(root: string): StorageLayout;
export declare function createPortableStorageLayout(root: string): StorageLayout;
/** Existing projects keep their original paths until a portable config is installed. */
export declare function resolveStorageLayout(root: string): StorageLayout;
