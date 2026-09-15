import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import {
	asCallSiteTag, findEnclosingCallSiteTag, findEnclosingOpeningTag,
	openAttrValueEdit, tagNameBeingTyped,
} from './tag-context.js';
import { makeDoc } from './test-helpers.js';

/** The `|` marks the cursor; returns the line without it and the column it sat at. */
function cursor(marked: string): { line: string; character: number } {
	return { line: marked.replace('|', ''), character: marked.indexOf('|') };
}

describe('tagNameBeingTyped', () => {
	it('answers right after the `<`, with nothing typed', () => {
		const { line, character } = cursor('<|');
		deepStrictEqual(tagNameBeingTyped(line, character), { typed: '', start: 1, end: 1 });
	});

	it('reports the name typed so far', () => {
		const { line, character } = cursor('  <my-ca|');
		deepStrictEqual(tagNameBeingTyped(line, character), { typed: 'my-ca', start: 3, end: 8 });
	});

	it('reaches past the cursor to the end of a name being edited', () => {
		const { line, character } = cursor('<my-|card>');
		deepStrictEqual(tagNameBeingTyped(line, character), { typed: 'my-', start: 1, end: 8 });
	});

	it('answers inside the `<>` an auto-closing editor inserted', () => {
		const { line, character } = cursor('<my-c|>');
		strictEqual(tagNameBeingTyped(line, character)?.typed, 'my-c');
	});

	it('does not answer in an attribute area, a closing tag, or text', () => {
		for (const marked of ['<div cla|', '<div>text |', '</my-ca|', 'plain wo|rd']) {
			const { line, character } = cursor(marked);
			strictEqual(tagNameBeingTyped(line, character), null, marked);
		}
	});
});

describe('openAttrValueEdit', () => {
	const bPart = '(?<![\\w-])b-part';

	it('reports the value typed so far and the whole value as the extent', () => {
		const { line, character } = cursor('<div b-part="#ca|rd">');
		deepStrictEqual(openAttrValueEdit(line, character, bPart), {
			name: 'b-part', typed: '#ca', valueStart: 13, valueEnd: 18,
		});
	});

	it('answers an empty value, where start and end are the cursor', () => {
		const { line, character } = cursor('<div b-part="|">');
		deepStrictEqual(openAttrValueEdit(line, character, bPart), {
			name: 'b-part', typed: '', valueStart: 13, valueEnd: 13,
		});
	});

	it('answers a single-quoted value', () => {
		const { line, character } = cursor("<div b-part='#ca|rd'>");
		strictEqual(openAttrValueEdit(line, character, bPart)?.typed, '#ca');
	});

	it('does not answer once the value is closed, or for another attribute', () => {
		for (const marked of ['<div b-part="#card">|', '<div class="#ca|rd">', '<div data-b-part="#ca|rd">']) {
			const { line, character } = cursor(marked);
			strictEqual(openAttrValueEdit(line, character, bPart), null, marked);
		}
	});
});

describe('asCallSiteTag', () => {
	const tag = (tagName: string, openTagText: string) => ({ tagName, openTagText, startOffset: 0 });

	it('reads the b-part value off any tag', () => {
		strictEqual(asCallSiteTag(tag('div', '<div b-part="#card">'))?.bPartValue, '#card');
	});

	it('treats a custom element tag as a call with no b-part value', () => {
		deepStrictEqual(asCallSiteTag(tag('my-card', '<my-card>')), {
			tagName: 'my-card', openTagText: '<my-card>', startOffset: 0, bPartValue: null,
		});
	});

	it('is not fooled by a plain tag or a b-* directive tag', () => {
		strictEqual(asCallSiteTag(tag('div', '<div class="card">')), null);
		strictEqual(asCallSiteTag(tag('b-unwrap', '<b-unwrap b-slot="x">')), null);
	});
});

describe('findEnclosingCallSiteTag', () => {
	/** The call enclosing the `|` in the given lines. */
	function callAt(lines: string[]) {
		let line = -1;
		let character = -1;
		const cleaned = lines.map((text, i) => {
			const at = text.indexOf('|');
			if (at !== -1) {
				line = i;
				character = at;
			}
			return text.replace('|', '');
		});
		return findEnclosingCallSiteTag(makeDoc(cleaned), line, character);
	}

	it('finds the call the tag is a child of', () => {
		const call = callAt([
			'<div b-name="page">',
			'  <div b-part="#card">',
			'    <b-unwrap b-in="|"></b-unwrap>',
			'  </div>',
			'</div>',
		]);
		strictEqual(call?.bPartValue, '#card');
	});

	it('skips a sibling call that has already closed', () => {
		const call = callAt([
			'<div b-name="page">',
			'  <div b-part="#card">',
			'    <div b-part="#chip"></div>',
			'    <b-unwrap b-in="|"></b-unwrap>',
			'  </div>',
			'</div>',
		]);
		strictEqual(call?.bPartValue, '#card');
	});

	it('takes the innermost call when calls nest', () => {
		const call = callAt([
			'<div b-name="page">',
			'  <div b-part="#outer">',
			'    <div b-part="#inner">',
			'      <b-unwrap b-in="|"></b-unwrap>',
			'    </div>',
			'  </div>',
			'</div>',
		]);
		strictEqual(call?.bPartValue, '#inner');
	});

	it('finds a custom element call', () => {
		const call = callAt([
			'<div b-name="page">',
			'  <my-card>',
			'    <b-unwrap b-in="|"></b-unwrap>',
			'  </my-card>',
			'</div>',
		]);
		strictEqual(call?.tagName, 'my-card');
		strictEqual(call?.bPartValue, null);
	});

	it('is not thrown off by void or self-closing tags in between', () => {
		const call = callAt([
			'<div b-name="page">',
			'  <div b-part="#card">',
			'    <img src="x.png">',
			'    <br>',
			'    <b-unwrap b-slot="note" />',
			'    <b-unwrap b-in="|"></b-unwrap>',
			'  </div>',
			'</div>',
		]);
		strictEqual(call?.bPartValue, '#card');
	});

	it('is not thrown off by a `<` inside an attribute value', () => {
		const call = callAt([
			'<div b-name="page">',
			'  <div b-part="#card">',
			'    <div title="a < b"></div>',
			'    <b-unwrap b-in="|"></b-unwrap>',
			'  </div>',
			'</div>',
		]);
		strictEqual(call?.bPartValue, '#card');
	});

	it('resolves a call whose opening tag spans several lines', () => {
		const call = callAt([
			'<div b-name="page">',
			'  <div',
			'    b-part="#card"',
			'    class="wide">',
			'    <b-unwrap b-in="|"></b-unwrap>',
			'  </div>',
			'</div>',
		]);
		strictEqual(call?.bPartValue, '#card');
	});

	it('answers nothing when the parent element makes no call', () => {
		strictEqual(callAt([
			'<div b-name="page">',
			'  <div class="wrap">',
			'    <b-unwrap b-in="|"></b-unwrap>',
			'  </div>',
			'</div>',
		]), null);
	});

	it('answers nothing at the top level', () => {
		strictEqual(callAt(['<b-unwrap b-in="|"></b-unwrap>']), null);
	});
});

describe('findEnclosingOpeningTag', () => {
	it('reports the tag the cursor is in, and where it starts', () => {
		const doc = makeDoc(['<div b-name="page">', '  <my-card label="hi">']);
		const tag = findEnclosingOpeningTag(doc, 1, 18);
		strictEqual(tag?.tagName, 'my-card');
		strictEqual(tag?.startOffset, doc.getText().indexOf('<my-card'));
	});
});
