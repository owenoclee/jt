/** Is a process with this pid running? SIGCONT probes liveness without disturbing it. */
export function pidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}
