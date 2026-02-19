// Debug logger - stores logs in memory only (never persisted to disk)
// Logs are lost when the service worker restarts, which is acceptable for debug data
const MAX_LOGS = 200;
let memoryLogs: string[] = [];

export function debugLog(source: string, ...args: unknown[]): void {
  const msg = args.map(a => {
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    if (typeof a === 'object') try { return JSON.stringify(a); } catch { return String(a); }
    return String(a);
  }).join(' ');

  const entry = `[${new Date().toISOString()}] [${source}] ${msg}`;
  memoryLogs.push(entry);
  if (memoryLogs.length > MAX_LOGS) memoryLogs.splice(0, memoryLogs.length - MAX_LOGS);
}

export function getDebugLogs(): string[] {
  return [...memoryLogs];
}

export function clearDebugLogs(): void {
  memoryLogs = [];
}
