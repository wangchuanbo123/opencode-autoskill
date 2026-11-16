import { existsSync } from "node:fs";
import * as path from "node:path";
export function createLegacyStorageLayout(root) {
    const resolved = path.resolve(root);
    return { kind: "legacy", root: resolved, skillsRoot: path.join(resolved, ".opencode", "skills"),
        stateRoot: path.join(resolved, ".opencode", "autoskill"), configFile: path.join(resolved, ".autoskill", "config.json") };
}
export function createPortableStorageLayout(root) {
    const resolved = path.resolve(root);
    return { kind: "portable", root: resolved, skillsRoot: path.join(resolved, ".autoskill", "skills"),
        stateRoot: path.join(resolved, ".autoskill", "runtime"), configFile: path.join(resolved, ".autoskill", "config.json") };
}
/** Existing projects keep their original paths until a portable config is installed. */
export function resolveStorageLayout(root) {
    const portable = createPortableStorageLayout(root);
    return existsSync(portable.configFile) ? portable : createLegacyStorageLayout(root);
}
//# sourceMappingURL=storage-layout.js.map