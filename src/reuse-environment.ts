import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReuseEnvironment } from "./retrieval.js";

/** Read only bounded project manifests; no shell, home search, environment values or recursive scan. */
export async function detectReuseEnvironment(root: string, signal?: AbortSignal): Promise<ReuseEnvironment> {
  const technologies = new Set<string>(), facts = new Set<string>();
  async function read(name: string): Promise<string | undefined> {
    signal?.throwIfAborted(); const file = path.join(root, name);
    try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) return;
      const content = await fs.readFile(file, "utf8"); signal?.throwIfAborted(); facts.add(`Project file exists: ${name}`); return content;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const manifest = await read("package.json");
  if (manifest) {
    try {
      const value = JSON.parse(manifest); technologies.add("node");
      const dependencies = [...Object.keys(value.dependencies ?? {}), ...Object.keys(value.devDependencies ?? {})];
      const known: Record<string, string> = { next: "nextjs", react: "react", vue: "vue", svelte: "svelte", "@angular/core": "angular", express: "express",
        pg: "postgresql", mysql: "mysql", mysql2: "mysql", "better-sqlite3": "sqlite", sqlite3: "sqlite", redis: "redis", ioredis: "redis", mongodb: "mongodb", typescript: "typescript" };
      for (const dependency of dependencies) if (known[dependency]) technologies.add(known[dependency]!);
    } catch { /* Invalid manifests supply no stack facts. */ }
  }
  for (const [marker, technology] of [["pyproject.toml", "python"], ["requirements.txt", "python"], ["go.mod", "go"], ["Cargo.toml", "rust"], ["pom.xml", "java"], ["Gemfile", "ruby"], ["composer.json", "php"], ["deno.json", "deno"], ["bun.lock", "bun"]]) {
    const content = await read(marker!); if (content === undefined) continue; technologies.add(technology!);
    if (technology === "python") for (const framework of ["django", "fastapi", "flask"]) if (new RegExp(`\\b${framework}\\b`, "i").test(content)) technologies.add(framework);
  }
  // Plugin runtime versions are not assumed to be the project's subprocess runtime.
  return { technologies: [...technologies].sort(), platform: process.platform, facts: [...facts].sort() };
}
