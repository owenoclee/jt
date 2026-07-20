/** Minimal ANSI helpers; colors only when stdout is a terminal (agents get plain text). */

const tty = (() => {
  try {
    return Deno.stdout.isTerminal();
  } catch {
    return false;
  }
})();

function wrap(code: number, close: number) {
  return (s: string) => (tty ? `\x1b[${code}m${s}\x1b[${close}m` : s);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
