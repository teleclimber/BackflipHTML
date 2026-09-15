/**
 * Where an asset path can be written on a line, and what the cursor is on.
 *
 * Two attribute forms name an asset: any attribute with the `~` suffix
 * (`src~=`, `:srcset~=`), and `b-script=` on a custom element partial
 * definition. Hover, go-to-definition, find-references and completion all read
 * them through here, so the set of forms is stated once rather than four times.
 *
 * These probes match the line's text, not the compiled tree, so they answer
 * while the attribute is still being typed — which is what completion needs.
 */

/** An asset-naming attribute, and where its value sits on the line. */
export interface AssetAttrMatch {
	/** As authored, suffix included: `src~`, `:srcset~`, `b-script`. */
	name: string;
	/** A comma-separated candidate list rather than a single url. */
	isSrcset: boolean;
	value: string;
	/** Column of the value's first character. */
	valueStart: number;
	/** Columns the whole attribute spans. */
	start: number;
	end: number;
}

/** The `@name/subpath` being typed, and the columns an edit should replace. */
export interface AssetRefEdit {
	/** The ref as authored up to the cursor; empty where none has been started. */
	typed: string;
	/** Column the ref starts at, which is the cursor when nothing is typed. */
	start: number;
	/** Column one past the ref's last character, which may sit after the cursor. */
	end: number;
}

/** One `@name/subpath` within such an attribute. */
export interface AssetRefMatch {
	/** Asset directory name, without the `@`. */
	name: string;
	subpath: string;
	/** Columns the `@name/subpath` spans. */
	start: number;
	end: number;
}

// The attribute name, then a quoted value. A `~` name may start at a `:` — that
// is how the long form `b-bind:src~` is reached, the match beginning at its
// colon — so only the `b-script` branch carries a lookbehind, to keep it from
// matching inside a longer name like `data-b-script`.
const ASSET_ATTR = /((?::?[a-zA-Z][a-zA-Z0-9-]*~)|(?<![\w-])b-script)=(["'])([^"']*)\2/g;

// The same, with the quote still open: everything from `="` to the cursor.
const OPEN_ASSET_ATTR = /((?::?[a-zA-Z][a-zA-Z0-9-]*~)|(?<![\w-])b-script)=["']([^"']*)$/;

function isSrcsetName(name: string): boolean {
	return name.replace(/^:/, '').replace(/~$/, '') === 'srcset';
}

/** The asset-naming attribute the cursor is inside, if any. */
export function assetAttrAtCursor(line: string, character: number): AssetAttrMatch | null {
	ASSET_ATTR.lastIndex = 0;
	let m;
	while ((m = ASSET_ATTR.exec(line)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		if (character < start || character > end) continue;
		return {
			name: m[1],
			isSrcset: isSrcsetName(m[1]),
			value: m[3],
			valueStart: start + m[0].indexOf(m[2]) + 1,
			start,
			end,
		};
	}
	return null;
}

/**
 * The `@name/subpath` the cursor is on. Null when the cursor is in an asset
 * attribute but not on one of its refs — `assetAttrAtCursor` still answers
 * there, which is how hover tells the two apart.
 */
export function assetRefAtCursor(line: string, character: number): AssetRefMatch | null {
	const attr = assetAttrAtCursor(line, character);
	if (!attr) return null;
	return assetRefInValue(attr, character);
}

/** As above, for a caller that already has the attribute. */
export function assetRefInValue(attr: AssetAttrMatch, character: number): AssetRefMatch | null {
	const refRegex = /@([a-zA-Z0-9_-]+)\//g;
	let m;
	while ((m = refRegex.exec(attr.value)) !== null) {
		const afterPrefix = m.index + m[0].length;
		const rest = attr.value.substring(afterPrefix);
		// A srcset candidate ends at its descriptor or the next comma; every
		// other attribute holds one url, so the rest of the value is the subpath.
		const subpath = attr.isSrcset ? rest.split(',')[0].split(/\s/)[0] : rest;
		const start = attr.valueStart + m.index;
		const end = attr.valueStart + afterPrefix + subpath.length;
		if (character >= start && character <= end) {
			return { name: m[1], subpath, start, end };
		}
	}
	return null;
}

/**
 * The value typed so far in an asset attribute whose quote is still open, given
 * the line up to the cursor. Null when the cursor is not in one.
 */
export function openAssetAttrValue(linePrefix: string): string | null {
	const m = linePrefix.match(OPEN_ASSET_ATTR);
	return m ? m[2] : null;
}

/**
 * The ref being typed at the cursor, and the extent a completion replaces.
 *
 * A value names one asset, and a srcset one per candidate, so the ref is the
 * token that opens the candidate the cursor is in — empty while the value is,
 * and missing its `@` until that is typed. Anything past that first token is a
 * srcset descriptor and names nothing, so the cursor resolves to no ref there.
 *
 * The extent reaches back over what is typed and forward past the cursor to the
 * end of the token, so accepting a completion rewrites the whole ref rather
 * than appending to what is already there.
 */
export function assetRefEditAtCursor(line: string, character: number): AssetRefEdit | null {
	const value = openAssetAttrValue(line.substring(0, character));
	if (value === null) return null;
	const candidate = value.substring(value.lastIndexOf(',') + 1);
	const typed = candidate.match(/[^\s]*$/)![0];
	if (candidate.slice(0, candidate.length - typed.length).trim() !== '') return null;
	const ahead = line.substring(character).match(/^[^\s,"']*/)![0];
	return {
		typed,
		start: character - typed.length,
		end: character + ahead.length,
	};
}
