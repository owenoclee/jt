/** Expected, user-facing errors — printed without a stack trace. */
export class UserError extends Error {}

export function fail(message: string): never {
  throw new UserError(message);
}
