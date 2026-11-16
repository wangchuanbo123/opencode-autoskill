export interface MigrationOptions {
    root: string;
    dryRun?: boolean;
    rollback?: boolean;
}
/** Offline copy migration. Originals remain intact; SQLite snapshots include WAL data. */
export declare function migrateProject(input: MigrationOptions): Promise<Record<string, unknown>>;
/** Rollback is allowed only before migrated data/configuration acquires any edits. */
export declare function rollbackMigration(input: MigrationOptions): Promise<Record<string, unknown>>;
