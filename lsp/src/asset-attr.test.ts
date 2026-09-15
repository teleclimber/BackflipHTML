import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { assetAttrAtCursor, assetRefAtCursor, assetRefEditAtCursor, openAssetAttrValue } from './asset-attr.js';

describe('assetAttrAtCursor', () => {
	it('finds a ~ attribute the cursor sits in', () => {
		const line = '<img src~="@images/photo.jpg" />';
		const m = assetAttrAtCursor(line, 15)!;
		ok(m, 'expected a match');
		strictEqual(m.name, 'src~');
		strictEqual(m.value, '@images/photo.jpg');
		strictEqual(m.valueStart, line.indexOf('@images'));
	});

	it('finds a bind (:) form', () => {
		const line = '<img :src~="@images/banner.png" />';
		strictEqual(assetAttrAtCursor(line, 16)!.name, ':src~');
	});

	it('finds the b-bind long form, whose name the match starts mid-attribute', () => {
		const line = '<img b-bind:src~="@images/banner.png" />';
		const m = assetAttrAtCursor(line, 22)!;
		ok(m, 'expected a match');
		strictEqual(m.value, '@images/banner.png');
	});

	it('finds b-script, which names an asset without the ~ suffix', () => {
		const line = '<my-widget b-attr:count b-script="@scripts/my-widget.js">';
		const m = assetAttrAtCursor(line, 40)!;
		ok(m, 'expected a match');
		strictEqual(m.name, 'b-script');
		strictEqual(m.value, '@scripts/my-widget.js');
	});

	it('marks srcset in both plain and bind form', () => {
		strictEqual(assetAttrAtCursor('<img srcset~="@images/a.png 1x" />', 20)!.isSrcset, true);
		strictEqual(assetAttrAtCursor('<img :srcset~="@images/a.png 1x" />', 21)!.isSrcset, true);
		strictEqual(assetAttrAtCursor('<img src~="@images/a.png" />', 15)!.isSrcset, false);
	});

	it('ignores a plain attribute that carries neither ~ nor the b-script name', () => {
		strictEqual(assetAttrAtCursor('<img src="@images/photo.jpg" />', 15), null);
	});

	it('does not mistake an attribute merely ending in b-script', () => {
		// `\b` alone would match inside `data-b-script`, which is not a directive.
		strictEqual(assetAttrAtCursor('<div data-b-script="@scripts/x.js">', 25), null);
	});

	it('returns null when the cursor is on a different attribute', () => {
		const line = '<img src="regular.jpg" src~="@images/photo.jpg" />';
		strictEqual(assetAttrAtCursor(line, 12), null);
	});
});

describe('assetRefAtCursor', () => {
	it('reads the @name/subpath under the cursor in a ~ attribute', () => {
		const line = '<img src~="@images/photo.jpg" />';
		deepStrictEqual(assetRefAtCursor(line, 15), {
			name: 'images',
			subpath: 'photo.jpg',
			start: line.indexOf('@images'),
			end: line.indexOf('@images') + '@images/photo.jpg'.length,
		});
	});

	it('reads the @name/subpath under the cursor in b-script', () => {
		const line = '<my-widget b-attr:count b-script="@scripts/my-widget.js">';
		const r = assetRefAtCursor(line, 40)!;
		ok(r, 'expected a ref');
		strictEqual(r.name, 'scripts');
		strictEqual(r.subpath, 'my-widget.js');
		strictEqual(r.start, line.indexOf('@scripts'));
		strictEqual(r.end, line.indexOf('@scripts') + '@scripts/my-widget.js'.length);
	});

	it('reads a ref in the b-bind long form', () => {
		const line = '<img b-bind:src~="@images/banner.png" />';
		deepStrictEqual(assetRefAtCursor(line, 22), {
			name: 'images',
			subpath: 'banner.png',
			start: line.indexOf('@images'),
			end: line.indexOf('@images') + '@images/banner.png'.length,
		});
	});

	it('splits srcset candidates so each ref spans only its own url', () => {
		const line = '<img srcset~="@images/photo.jpg 1x, @images/icon.png 2x" />';
		strictEqual(assetRefAtCursor(line, 20)!.subpath, 'photo.jpg');
		strictEqual(assetRefAtCursor(line, 45)!.subpath, 'icon.png');
	});

	it('returns null on an asset attribute whose value holds no @ref', () => {
		strictEqual(assetRefAtCursor('<my-widget b-script="">', 21), null);
	});
});

describe('openAssetAttrValue', () => {
	it('reads what has been typed so far in a ~ attribute', () => {
		strictEqual(openAssetAttrValue('<img src~="@'), '@');
		strictEqual(openAssetAttrValue('<img src~="@images/ph'), '@images/ph');
	});

	it('reads what has been typed so far in the b-bind long form', () => {
		strictEqual(openAssetAttrValue('<img b-bind:src~="@ima'), '@ima');
	});

	it('reads what has been typed so far in b-script', () => {
		strictEqual(openAssetAttrValue('<my-widget b-script="@'), '@');
		strictEqual(openAssetAttrValue('<my-widget b-script="@scripts/'), '@scripts/');
	});

	it('returns null once the quote is closed', () => {
		strictEqual(openAssetAttrValue('<img src~="@images/photo.jpg"'), null);
	});

	it('returns null for an attribute that names no asset', () => {
		strictEqual(openAssetAttrValue('<img src="@'), null);
	});
});

describe('assetRefEditAtCursor', () => {
	/** The probe for a line whose cursor is written as `|`. */
	function at(marked: string) {
		return assetRefEditAtCursor(marked.replace('|', ''), marked.indexOf('|'));
	}

	it('spans the bare `@` that starts a ref', () => {
		const marked = '<img src~="@|">';
		deepStrictEqual(at(marked), {
			typed: '@',
			start: marked.indexOf('@'),
			end: marked.indexOf('|'),
		});
	});

	it('spans back to the `@` while the ref is being typed', () => {
		const marked = '<img src~="@assets/st|">';
		deepStrictEqual(at(marked), {
			typed: '@assets/st',
			start: marked.indexOf('@'),
			end: marked.indexOf('|'),
		});
	});

	it('spans forward past the cursor to the end of a ref being edited', () => {
		const marked = '<img src~="@assets/st|yle.css">';
		const line = marked.replace('|', '');
		deepStrictEqual(at(marked), {
			typed: '@assets/st',
			start: line.indexOf('@'),
			end: line.indexOf('@') + '@assets/style.css'.length,
		});
	});

	it('spans only the candidate under the cursor in a srcset', () => {
		const marked = '<img srcset~="@images/a.png 1x, @im|ages/b.png 2x">';
		const line = marked.replace('|', '');
		deepStrictEqual(at(marked), {
			typed: '@im',
			start: line.lastIndexOf('@'),
			end: line.lastIndexOf('@') + '@images/b.png'.length,
		});
	});

	it('stops at the descriptor that ends a srcset candidate', () => {
		const marked = '<img srcset~="@images/a|.png 1x, @images/b.png 2x">';
		const line = marked.replace('|', '');
		strictEqual(at(marked)!.end, line.indexOf('@') + '@images/a.png'.length);
	});

	it('spans a b-script ref, which carries no `~`', () => {
		const marked = '<my-widget b-script="@scr|">';
		deepStrictEqual(at(marked), {
			typed: '@scr',
			start: marked.indexOf('@'),
			end: marked.indexOf('|'),
		});
	});

	it('spans nothing in an empty value, where a ref has yet to be started', () => {
		const marked = '<img src~="|">';
		deepStrictEqual(at(marked), {
			typed: '',
			start: marked.indexOf('|'),
			end: marked.indexOf('|'),
		});
	});

	it('spans nothing at an empty srcset candidate', () => {
		const marked = '<img srcset~="@images/a.png 1x, |">';
		deepStrictEqual(at(marked), {
			typed: '',
			start: marked.indexOf('|'),
			end: marked.indexOf('|'),
		});
	});

	it('spans a name typed without its `@`, which the value still needs', () => {
		const marked = '<img src~="as|">';
		deepStrictEqual(at(marked), {
			typed: 'as',
			start: marked.indexOf('as'),
			end: marked.indexOf('|'),
		});
	});

	it('returns null past the end of a srcset candidate', () => {
		strictEqual(at('<img srcset~="@images/a.png 1x|">'), null);
	});

	it('returns null outside an asset attribute', () => {
		strictEqual(at('<img src="@assets/st|">'), null);
	});
});
