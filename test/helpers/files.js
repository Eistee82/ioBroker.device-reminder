// In-memory files of the adapter (learning data of the automatic optimisation).

/**
 * In-memory file io that counts the writes.
 *
 * @returns {{ files: Map<string, string>, writes: number, read: (name: string) => Promise<string | null>, write: (name: string, data: string) => Promise<void>, remove: (name: string) => Promise<void> }} file io
 */
export function memoryFiles() {
	const files = new Map();
	return {
		files,
		writes: 0,
		async read(name) {
			return files.has(name) ? files.get(name) : null;
		},
		async write(name, data) {
			this.writes++;
			files.set(name, data);
		},
		async remove(name) {
			files.delete(name);
		},
	};
}
