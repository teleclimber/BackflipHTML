import { assertEquals } from "jsr:@std/assert";
import {
	attrLoc, tagLoc, tagSrcLoc, errorLoc, attrErrorLoc, bDataNameLoc,
	interpolationLoc, LineMap, dataLocAttr,
} from "./loc.ts";

// A parse5-shaped tag with attribute source locations.
const tagWithAttrs = {
	sourceCodeLocation: {
		startLine: 2, startCol: 3, startOffset: 20, endLine: 2, endCol: 40, endOffset: 57,
		attrs: {
			'class': { startLine: 2, startCol: 8, startOffset: 25, endLine: 2, endCol: 20, endOffset: 37 },
			'b-data:title': { startLine: 2, startCol: 22, startOffset: 39, endLine: 2, endCol: 40, endOffset: 57 },
		},
	},
};

Deno.test("attrLoc: returns the attribute's SourceLoc", () => {
	assertEquals(attrLoc(tagWithAttrs, 'class'), {
		startLine: 2, startCol: 8, startOffset: 25, endLine: 2, endCol: 20, endOffset: 37,
	});
});

Deno.test("attrLoc: undefined for missing attr or missing location", () => {
	assertEquals(attrLoc(tagWithAttrs, 'id'), undefined);
	assertEquals(attrLoc({}, 'class'), undefined);
});

Deno.test("tagLoc: line/col from the tag, empty object when absent", () => {
	assertEquals(tagLoc(tagWithAttrs), { line: 2, col: 3 });
	assertEquals(tagLoc({}), {});
});

Deno.test("tagSrcLoc: converts a full parse5 loc to SourceLoc", () => {
	assertEquals(tagSrcLoc(tagWithAttrs), {
		startLine: 2, startCol: 3, startOffset: 20, endLine: 2, endCol: 40, endOffset: 57,
	});
});

Deno.test("tagSrcLoc: undefined when startLine is missing", () => {
	assertEquals(tagSrcLoc({}), undefined);
	assertEquals(tagSrcLoc({ sourceCodeLocation: { startCol: 1 } }), undefined);
});

Deno.test("tagSrcLoc: fallbackLen fills endOffset when the parser omits it", () => {
	const tag = { sourceCodeLocation: { startLine: 1, startCol: 1, startOffset: 10 } };
	// Default fallback (0): endOffset === startOffset.
	assertEquals(tagSrcLoc(tag)!.endOffset, 10);
	// Explicit fallback: endOffset === startOffset + len.
	assertEquals(tagSrcLoc(tag, 5)!.endOffset, 15);
});

Deno.test("errorLoc: builds a loc object, undefined when there's nothing to point at", () => {
	assertEquals(errorLoc('f.html', { line: 3, col: 4 }), { filename: 'f.html', line: 3, col: 4 });
	assertEquals(errorLoc(undefined, undefined), undefined);
	assertEquals(errorLoc(undefined, { col: 2 }), undefined);
});

// Pre-converted SourceLocs, as parse-tree.ts hands them to lowering.
const openLoc = tagSrcLoc(tagWithAttrs);
const classLoc = attrLoc(tagWithAttrs, 'class');
const bDataTitleLoc = attrLoc(tagWithAttrs, 'b-data:title');

Deno.test("attrErrorLoc: uses the attr span when present", () => {
	assertEquals(attrErrorLoc(classLoc, openLoc, 'f.html'), {
		filename: 'f.html', line: 2, col: 8, endLine: 2, endCol: 20,
	});
});

Deno.test("attrErrorLoc: falls back to the open tag location when the attr has none", () => {
	assertEquals(attrErrorLoc(undefined, openLoc, 'f.html'), {
		filename: 'f.html', line: 2, col: 3,
	});
});

Deno.test("bDataNameLoc: spans just the NAME after the b-data: prefix", () => {
	// 'b-data:' is 7 chars; the name 'title' is 5 chars.
	const loc = bDataNameLoc(bDataTitleLoc, 'title')!;
	assertEquals(loc.startCol, 22 + 7);
	assertEquals(loc.startOffset, 39 + 7);
	assertEquals(loc.endCol, 22 + 7 + 5);
	assertEquals(loc.endOffset, 39 + 7 + 5);
});

Deno.test("interpolationLoc: offsets/cols on a single line", () => {
	const loc = interpolationLoc({ startLine: 1, startCol: 1, startOffset: 0 }, 'ab', '{{x}}');
	assertEquals(loc.startOffset, 2);
	assertEquals(loc.endOffset, 7);
	assertEquals(loc.startLine, 1);
	assertEquals(loc.startCol, 3);
	assertEquals(loc.endCol, 8);
});

Deno.test("interpolationLoc: accounts for newlines in the preceding text", () => {
	const loc = interpolationLoc({ startLine: 1, startCol: 1, startOffset: 0 }, 'a\nbc', '{{y}}');
	assertEquals(loc.startLine, 2);
	// col resets relative to the last newline
	assertEquals(loc.startCol, 3);
});

Deno.test("LineMap: maps offsets to 1-based line/col", () => {
	const lm = new LineMap('a\nbb\nccc');
	assertEquals(lm.getLoc(0), { line: 1, col: 1 });
	assertEquals(lm.getLoc(2), { line: 2, col: 1 });
	assertEquals(lm.getLoc(3), { line: 2, col: 2 });
	assertEquals(lm.getLoc(5), { line: 3, col: 1 });
});

Deno.test("dataLocAttr: emits data-loc only when enabled and inside a partial", () => {
	assertEquals(
		dataLocAttr(openLoc, { includeLocs: true, currentPartialName: 'card', filename: 'f.html' }),
		' data-loc="f.html#card:2:3"'
	);
	assertEquals(dataLocAttr(openLoc, { includeLocs: false, currentPartialName: 'card', filename: 'f.html' }), '');
	assertEquals(dataLocAttr(openLoc, { includeLocs: true, currentPartialName: null, filename: 'f.html' }), '');
	assertEquals(dataLocAttr(undefined, { includeLocs: true, currentPartialName: 'card', filename: 'f.html' }), '');
});
