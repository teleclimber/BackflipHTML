/**
 * Which pseudo-classes and pseudo-elements Backflip cannot answer, and what
 * kind of thing each one is.
 *
 * This map is the *criterion* for relaxation (see `relax-selector.ts`): a name
 * listed here is stripped from a selector before matching, because whether it
 * holds is not a property of the template. It is deliberately not derived from
 * `css-select`'s `filters` / `pseudos` / `aliases` tables, which answer a
 * different question — "can this library compile it?" rather than "can Backflip
 * know the answer?".
 *
 * Two consequences, both wanted:
 *
 * - A future `css-select` that learns `:focus` changes nothing here. `:focus`
 *   was never ours to answer.
 * - `:checked`, `:disabled`, `:enabled`, `:required` and `:optional` are
 *   stripped *even though* `css-select` supports them. It resolves them to
 *   attribute presence — `:checked` becomes `[checked]` — which is the
 *   template's initial markup, not the element's state. `input:checked + label`
 *   is the canonical CSS toggle pattern and would otherwise match nothing.
 *
 * The converse does not hold, though: an upgrade that makes `css-select` answer
 * something the *template* knows is a reason to drop an entry. `css-select` 7
 * did exactly that to `:lang()`, which now resolves through `getAttributeValue`
 * against the markup's own `lang` attributes — so `lang` is not listed. `dir`
 * stays: it resolves through inheritance and `dir=auto` content heuristics the
 * template alone does not settle. Worth re-checking `dir` and the `input`
 * category on future `css-select` upgrades for the same reason.
 *
 * What stays native: everything tree-structural (`:first-child`,
 * `:nth-child()` — including `:nth-child(2 of S)` — `:root`, `:empty`,
 * `:only-of-type`, …), the functional pseudos (`:is`, `:not`, `:where`,
 * `:has`), `:scope`, `:lang()`, `:any-link` and `:link` (both reduce to
 * `[href]`), and `css-select`'s jQuery-flavored aliases (`:parent`, `:header`,
 * `:button`, `:checkbox`, `:submit`, `:text`, …).
 *
 * Categories are MDN's reference headings, read 2026-09-07:
 * https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/Pseudo-classes
 * https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/Pseudo-elements
 *
 * Three entries are decisions rather than transcription:
 *
 * - `blank` is `input`, not `page`. MDN lists it under both; page
 *   pseudo-classes only apply inside `@page` preludes, which never reach the
 *   matcher.
 * - `heading` is `elemental`, not `tree-structural`. MDN lists bare `:heading`
 *   under Elemental and `:heading()` under Tree-structural; `css-what` gives
 *   both the same token name, so they share one entry.
 * - `contains` / `icontains` are `not-implemented`. They are `css-select`
 *   extensions, absent from MDN. Backflip *could* answer them once template
 *   text is modelled, so the category marks work not yet done, distinct from
 *   "unknowable".
 */

export type PseudoCategory =
	// pseudo-class headings
	| 'elemental'
	| 'element-display-state'
	| 'input'
	| 'linguistic'
	| 'location'
	| 'resource-state'
	| 'time-dimensional'
	| 'shadow-structural'
	| 'user-action'
	| 'page'
	| 'view-transition'
	| 'custom-state'
	// pseudo-element headings
	| 'typographic'
	| 'highlight'
	| 'tree-abiding'
	| 'element-backed'
	| 'form-related'
	| 'non-standard'
	// outside MDN's tables
	| 'not-implemented'
	| 'unknown';

/**
 * The names in each category, keyed by `css-what` token name — no leading
 * colons, and one entry per pseudo rather than one per spelling.
 *
 * Keying by name rather than by token type is deliberate. `css-what` 8
 * tokenizes `:before` and `::before` alike as pseudo-*elements*, but it
 * tokenized them differently in version 6; a name is one entry instead of two
 * and does not depend on a detail that has already moved once. No name collides
 * between the pseudo-class and pseudo-element sets, so one flat map is sound.
 */
const BY_CATEGORY: Record<string, readonly string[]> = {
	'elemental': ['defined', 'heading'],

	'element-display-state': [
		'open', 'popover-open', 'modal', 'fullscreen', 'picture-in-picture', 'xr-overlay',
	],

	'input': [
		'enabled', 'disabled', 'read-only', 'read-write', 'placeholder-shown', 'autofill',
		'default', 'checked', 'indeterminate', 'blank', 'valid', 'invalid', 'in-range',
		'out-of-range', 'required', 'optional', 'user-valid', 'user-invalid',
	],

	'linguistic': ['dir'],

	'location': ['visited', 'local-link', 'target'],

	'resource-state': [
		'playing', 'paused', 'seeking', 'buffering', 'stalled', 'muted', 'volume-locked',
	],

	'time-dimensional': ['current', 'past', 'future'],

	'shadow-structural': ['host', 'host-context', 'has-slotted'],

	'user-action': ['hover', 'active', 'focus', 'focus-visible', 'focus-within', 'target-current'],

	'page': ['left', 'right', 'first'],

	'view-transition': ['active-view-transition', 'active-view-transition-type'],

	'custom-state': ['state'],

	'not-implemented': ['contains', 'icontains'],

	'typographic': ['first-line', 'first-letter', 'cue'],

	'highlight': [
		'grammar-error', 'highlight', 'search-text', 'selection', 'spelling-error', 'target-text',
	],

	'tree-abiding': [
		'before', 'after', 'column', 'marker', 'backdrop', 'scroll-button', 'scroll-marker',
		'scroll-marker-group',
	],

	'element-backed': ['details-content', 'part', 'slotted'],

	'form-related': ['checkmark', 'file-selector-button', 'picker', 'picker-icon', 'placeholder'],

	'non-standard': [
		'-moz-color-swatch', '-moz-focus-inner', '-moz-list-bullet', '-moz-list-number',
		'-moz-meter-bar', '-moz-progress-bar', '-moz-range-progress', '-moz-range-thumb',
		'-moz-range-track', '-webkit-inner-spin-button', '-webkit-meter-bar',
		'-webkit-meter-even-less-good-value', '-webkit-meter-inner-element',
		'-webkit-meter-optimum-value', '-webkit-meter-suboptimum-value', '-webkit-progress-bar',
		'-webkit-progress-inner-element', '-webkit-progress-value', '-webkit-scrollbar',
		'-webkit-search-cancel-button', '-webkit-search-results-button',
		'-webkit-slider-runnable-track', '-webkit-slider-thumb',
	],
};

/** Every pseudo Backflip strips, mapped to its one category. */
export const PSEUDO_CATEGORIES: ReadonlyMap<string, PseudoCategory> = new Map(
	Object.entries(BY_CATEGORY).flatMap(
		([category, names]) => names.map(name => [name, category as PseudoCategory] as const),
	),
);

/**
 * Vendor prefixes are open-ended, so enumerating them is a losing game: any
 * prefixed name the list does not carry is `non-standard` too.
 */
const VENDOR_PREFIXES = ['-moz-', '-webkit-', '-ms-', '-o-'];

/**
 * The category for a `css-what` token name, or `'unknown'` for a pseudo the
 * list has never heard of.
 *
 * Relaxation only ever categorizes names the list *does* carry, so `'unknown'`
 * reaches a `StrippedPseudo` by one route only: a functional pseudo — `:not`,
 * `:is`, `:where` — dropped because relaxing its argument emptied it. Those are
 * unlisted on purpose. An unlisted pseudo in a selector is not relaxed at all;
 * it is reported as a selector the matcher cannot read.
 */
export function categoryOf(name: string): PseudoCategory {
	const lower = name.toLowerCase();
	const listed = PSEUDO_CATEGORIES.get(lower);
	if (listed) return listed;
	if (VENDOR_PREFIXES.some(prefix => lower.startsWith(prefix))) return 'non-standard';
	return 'unknown';
}

/** Whether relaxation strips `name` — i.e. whether the list carries it at all. */
export function isStrippable(name: string): boolean {
	const lower = name.toLowerCase();
	return PSEUDO_CATEGORIES.has(lower) || VENDOR_PREFIXES.some(prefix => lower.startsWith(prefix));
}
