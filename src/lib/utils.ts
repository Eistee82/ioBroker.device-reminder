/**
 * Convert an unknown thrown value into a log-friendly message.
 *
 * @param err - Anything caught in a catch clause
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
