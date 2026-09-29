import { assertEquals } from "jsr:@std/assert";
import { JSDOM } from "npm:jsdom";

import { replaceBetween } from "./patch.ts";

function parentWith(innerHtml: string) {
	const dom = new JSDOM(`<!DOCTYPE html><body><div>${innerHtml}</div></body>`);
	const doc = dom.window.document;
	return { doc, parent: doc.querySelector('div')! };
}

function comments(parent: Node): string[] {
	return [...parent.childNodes].filter(n => n.nodeType === 8).map(n => n.nodeValue!);
}

Deno.test("replaceBetween: replaces the range, keeping siblings and markers", () => {
	const { doc, parent } = parentWith(`before<!--a-->old<b>x</b>old<!--b-->after`);
	replaceBetween(parent, 'a', 'b', doc.createTextNode('new'));
	assertEquals(parent.innerHTML, 'before<!--a-->new<!--b-->after');
	assertEquals(comments(parent), ['a', 'b']);
});

Deno.test("replaceBetween: fills an empty range", () => {
	const { doc, parent } = parentWith(`<!--a--><!--b-->`);
	replaceBetween(parent, 'a', 'b', doc.createTextNode('v'));
	assertEquals(parent.innerHTML, '<!--a-->v<!--b-->');
});

Deno.test("replaceBetween: inserts every node of a fragment", () => {
	const { doc, parent } = parentWith(`<!--a-->old<!--b-->`);
	const frag = doc.createDocumentFragment();
	frag.append(doc.createElement('i'), doc.createTextNode('t'));
	replaceBetween(parent, 'a', 'b', frag);
	assertEquals(parent.innerHTML, '<!--a--><i></i>t<!--b-->');
});

Deno.test("replaceBetween: repeated calls keep working on the same range", () => {
	const { doc, parent } = parentWith(`<!--a-->1<!--b-->`);
	replaceBetween(parent, 'a', 'b', doc.createTextNode('2'));
	replaceBetween(parent, 'a', 'b', doc.createTextNode('3'));
	assertEquals(parent.innerHTML, '<!--a-->3<!--b-->');
});

Deno.test("replaceBetween: leaves other marker ranges alone", () => {
	const { doc, parent } = parentWith(`<!--a-->1<!--b--><!--c-->2<!--d-->`);
	replaceBetween(parent, 'c', 'd', doc.createTextNode('x'));
	assertEquals(parent.innerHTML, '<!--a-->1<!--b--><!--c-->x<!--d-->');
});

Deno.test("replaceBetween: only matches direct children", () => {
	const { doc, parent } = parentWith(`<p><!--a-->1<!--b--></p>`);
	const errors: unknown[][] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		replaceBetween(parent, 'a', 'b', doc.createTextNode('x'));
	} finally {
		console.error = orig;
	}
	assertEquals(parent.innerHTML, '<p><!--a-->1<!--b--></p>');
	assertEquals(errors.length, 1);
});

for (const [label, html] of [
	['start', `old<!--b-->`],
	['end', `<!--a-->old`],
	['both', `old`],
] as const) {
	Deno.test(`replaceBetween: a missing ${label} marker logs and changes nothing`, () => {
		const { doc, parent } = parentWith(html);
		const errors: unknown[][] = [];
		const orig = console.error;
		console.error = (...args: unknown[]) => { errors.push(args); };
		try {
			replaceBetween(parent, 'a', 'b', doc.createTextNode('new'));
		} finally {
			console.error = orig;
		}
		assertEquals(parent.innerHTML, html);
		assertEquals(errors.length, 1);
		assertEquals(String(errors[0][0]).includes('comment markers a / b not found'), true);
		assertEquals(errors[0][1], parent);
	});
}
