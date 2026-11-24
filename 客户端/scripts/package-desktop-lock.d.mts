/**
 * Acquire the one-click launcher lock before opening the shared log.
 * @param directory Desktop build directory shared by launcher processes.
 * @returns Idempotent release operation.
 */
export declare function acquirePackageDesktopLock(directory: string): Promise<() => Promise<void>>
