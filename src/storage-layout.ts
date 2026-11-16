import { existsSync } from "node:fs";
import * as path from "node:path";

/** One project has one authoritative skill repository and private runtime. */
export interface StorageLayout {
  kind: "legacy" | "portable";
  root: string;
  skillsRoot: string;
  stateRoot: string;
  configFile: string;
}

export function createLegacyStorageLayout(root: string): StorageLayout {
  const resolved = path.resolve(root);
  return { kind: "legacy", root: resolved, skillsRoot: path.join(resolved, ".opencode", "skills"),
    stateRoot: path.join(resolved, ".opencode", "autoskill"), configFile: path.join(resolved, ".autoskill", "config.json") };
}

export function createPortableStorageLayout(root: string): StorageLayout {
  const resolved = path.resolve(root);
  return { kind: "portable", root: resolved, skillsRoot: path.join(resolved, ".autoskill", "skills"),
    stateRoot: path.join(resolved, ".autoskill", "runtime"), configFile: path.join(resolved, ".autoskill", "config.json") };
}

/** Existing projects keep their original paths until a portable config is installed. */
export function resolveStorageLayout(root: string): StorageLayout {
  const portable = createPortableStorageLayout(root);
  return existsSync(portable.configFile) ? portable : createLegacyStorageLayout(root);
}
