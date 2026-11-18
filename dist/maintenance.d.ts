/** Remove retained evidence while preserving ownership hashes and completed-job IDs. */
export declare function cleanEvidence(root: string, options?: {
    olderThanDays?: number;
    dryRun?: boolean;
}): Promise<{
    dryRun: boolean;
    jobs: number;
    files: number;
    eventTasks?: number;
    eventReceipts?: number;
}>;
