import type { BackcodeSite } from './collect.js';

/**
 * Predicate: true when a `BackcodeSite` should drive dom-patch codegen.
 *
 * Use with `Array.prototype.filter` (`sites.filter(qualifies)`). Kept as a
 * per-site predicate rather than a list-narrowing function so each downstream
 * consumer keeps the full `BackcodeSite` and switches on `site.kind` itself.
 * As more situations become patchable (prints, if-conditions, etc.), extend
 * the per-kind switch below.
 */
export function qualifies(s: BackcodeSite): boolean {
	// Cross-kind rules:
	if (s.liveVars.length === 0) return false;
	if (s.otherVars.length > 0) return false;
	if (s.inForLoop) return false;
	// Per-kind support (extend as new kinds become patchable):
	switch (s.site.kind) {
		case 'attr':
		case 'definition-root-attr':
			return true;
		case 'print':
		case 'if-condition':
		case 'for-iterable':
		case 'binding':
		case 'caller-attr-expr':
			return false;
	}
}
