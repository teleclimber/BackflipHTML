/**
 * Parse a b-part attribute value into its components.
 *
 * Formats:
 *   "#name"           → same-file reference (targetFile: null)
 *   "file.html#name"  → cross-file reference
 *   "name"            → bare name, same-file reference (targetFile: null)
 */
export function parseBPartValue(value: string): { partialName: string; targetFile: string | null } {
	if (value.startsWith('#')) {
		return { partialName: value.slice(1), targetFile: null };
	}
	const hashIdx = value.indexOf('#');
	if (hashIdx > 0) {
		return { partialName: value.slice(hashIdx + 1), targetFile: value.slice(0, hashIdx) };
	}
	return { partialName: value, targetFile: null };
}
