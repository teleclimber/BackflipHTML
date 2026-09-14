import { Location } from 'vscode-languageserver';
import { refSitesFor } from '@backflip/html';
import type { ProjectIndex, PartialRef } from './index.js';
import type { AssetReference } from '@backflip/assets';
import * as path from 'node:path';

/**
 * Every indexed reference that resolves to one partial definition.
 *
 * Find All References and the hover's count and link list all read this, so
 * they cannot disagree; the matching rule is the compiler's `refSitesFor`, so
 * they cannot disagree with the preview's counts either.
 */
export function matchingPartialRefs(
	partialName: string,
	defFile: string,
	index: ProjectIndex,
): PartialRef[] {
	return refSitesFor(index.partialRefs, partialName, defFile);
}

/**
 * Given a partial definition name, find all reference locations (b-part usages).
 *
 * A reference the compiler gave no location has nowhere to jump to and is
 * dropped.
 */
export function findReferences(
	partialName: string,
	defFile: string,
	index: ProjectIndex,
	workspaceRoot: string,
): Location[] {
	const locations: Location[] = [];

	for (const ref of matchingPartialRefs(partialName, defFile, index)) {
		if (!ref.loc) continue;

		locations.push({
			uri: `file://${workspaceRoot}/${ref.file}`,
			range: {
				start: {
					line: ref.loc.startLine - 1,
					character: ref.loc.startCol - 1,
				},
				end: {
					line: ref.loc.endLine - 1,
					character: ref.loc.endCol - 1,
				},
			},
		});
	}

	return locations;
}

/**
 * Given a cursor on an asset reference, extract the @name/subpath being referenced.
 * Returns { name, subpath } or null.
 */
export function parseAssetRefAtCursor(
	line: string,
	character: number,
): { name: string; subpath: string } | null {
	const regex = /:?([a-zA-Z][a-zA-Z0-9-]*)~=(["'])([^"']*)\2/g;
	let m;
	while ((m = regex.exec(line)) !== null) {
		const quote = m[2];
		const valueStart = m.index + m[0].indexOf(quote) + 1;
		const valueEnd = valueStart + m[3].length;
		if (character < valueStart || character > valueEnd) continue;

		const attrName = m[1];
		const value = m[3];

		const assetRefRegex = /@([a-zA-Z0-9_-]+)\//g;
		let refMatch;
		while ((refMatch = assetRefRegex.exec(value)) !== null) {
			const refStart = valueStart + refMatch.index;
			const afterRef = refMatch.index + refMatch[0].length;
			const rest = value.substring(afterRef);
			const subpath = attrName === 'srcset'
				? rest.split(',')[0].split(/\s/)[0]
				: rest;
			const refEnd = valueStart + afterRef + subpath.length;

			if (character >= refStart && character <= refEnd) {
				return { name: refMatch[1], subpath };
			}
		}
	}

	return null;
}

/**
 * Find every reference to one asset, as editor locations.
 *
 * `refs` comes from `collectAllAssetReferences`, which walks the compiled
 * trees and the stylesheets rather than the raw source, so what is listed here
 * is what actually renders: an `@name/subpath` sitting in text content, in a
 * comment, or on an attribute without the `~` suffix is not a reference and
 * does not appear, and one written across a line break does. Matching is on the
 * parsed name/subpath pair, so `photo.jpg` never matches `photo.jpg.bak`.
 *
 * Template references resolve against `templateRoot`; stylesheet references —
 * which carry no `partialName`, and whose `sourceFile` is relative to an asset
 * directory rather than the template root — resolve against that directory.
 * References with no source position (a `b-script` entry names an asset but has
 * nowhere to jump to) are dropped.
 */
export function findAssetReferences(
	assetName: string,
	assetSubpath: string,
	refs: AssetReference[],
	templateRoot: string,
	assetDirs: Map<string, string>,
): Location[] {
	const locations: Location[] = [];

	for (const ref of refs) {
		if (ref.assetName !== assetName || ref.assetSubpath !== assetSubpath) continue;
		if (ref.line <= 0) continue;

		const base = ref.partialName !== undefined ? templateRoot : assetDirs.get(ref.assetName);
		if (base === undefined) continue;

		// 1-based from the compiler and css-tree, 0-based in the protocol. An
		// absent end means the collector had only a start (stylesheet urls), so
		// the location is a caret rather than a wrong span.
		const start = { line: ref.line - 1, character: ref.column - 1 };
		const end = ref.endLine !== undefined && ref.endColumn !== undefined
			? { line: ref.endLine - 1, character: ref.endColumn - 1 }
			: start;

		locations.push({
			uri: `file://${base}/${ref.sourceFile}`,
			range: { start, end },
		});
	}

	return locations;
}
