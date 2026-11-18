/** Small filesystem helpers shared by the tool-owned layers. */

/**
 * Write a file by renaming a finished copy into place, so a reader never sees it half
 * written. Several of jt's state files are read by one process while another writes
 * them (an agent's command and the review server), and a torn read of one would look
 * like an empty file.
 */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.jt-${Deno.pid}.tmp`;
  Deno.writeTextFileSync(tmp, text);
  try {
    Deno.renameSync(tmp, path);
  } catch (e) {
    try {
      Deno.removeSync(tmp);
    } catch {
      // nothing left to clean up
    }
    throw e;
  }
}
