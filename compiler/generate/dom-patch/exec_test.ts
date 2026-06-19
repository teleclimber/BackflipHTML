// Behavioral tests for the generated dom-patch class: run it against a real DOM
// (jsdom) and assert the child-range patch actually mutates the document.
//
// This test deliberately does NOT import the compiler. jsdom requires parse5 as
// CommonJS, and the compiler pulls parse5 (via parse5-html-rewriting-stream) as
// an ES module; loading both in one Deno test triggers a require()-cycle error.
// The compiler → AST → marker-comment path is covered in nodes2patch_test.ts;
// here we hand-build the generated class and the server HTML it expects.
import { assertEquals } from "jsr:@std/assert";
import { JSDOM } from "npm:jsdom";

import type { ElementTNode, PrintTNode } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import type { BackcodeSite } from "./collect.ts";
import { generateClassForPartial, type BfidSite, type PatchTarget } from "./codegen.ts";

function printSite(target: PatchTarget, code: string, startId: string, endId: string): BfidSite {
	const node: PrintTNode = { type: 'print', data: interpretBackcode(code) };
	const backcode: BackcodeSite = {
		site: { kind: 'print', node, container: [node], parentElement: null },
		parsed: interpretBackcode(code),
		liveVars: interpretBackcode(code).vars,
		otherVars: [],
		inForLoop: false,
	};
	return { target, backcode, comments: { startId, endId } };
}

function attrSite(bfid: string, name: string, code: string): BfidSite {
	const attr = { type: 'dynamic' as const, name, expr: interpretBackcode(code), isBoolean: false };
	const element: ElementTNode = { type: 'element', tagName: 'div', attrs: [attr], tnodes: [] };
	const backcode: BackcodeSite = {
		site: { kind: 'attr', element, attr },
		parsed: attr.expr, liveVars: attr.expr.vars, otherVars: [], inForLoop: false,
	};
	return { target: { kind: 'bfid-element', bfid }, backcode };
}

// Instantiate `js`'s class against a host built from `innerHtml`, with
// globalThis.document pointed at the jsdom document for the duration.
function mount(js: string, partialName: string, className: string, hostAttrs: string, innerHtml: string) {
	const dom = new JSDOM(`<!DOCTYPE html><body><${partialName} ${hostAttrs}>${innerHtml}</${partialName}></body>`);
	const prevDoc = (globalThis as any).document;
	(globalThis as any).document = dom.window.document;
	const host = dom.window.document.querySelector(partialName)!;
	const Cls = new Function(js.replaceAll('export class', 'class') + `; return ${className};`)();
	const instance = new Cls(host);
	return { host, instance, restore: () => { (globalThis as any).document = prevDoc; } };
}

Deno.test("exec: updating a b-attr re-renders the print text, preserving siblings", () => {
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }],
		[printSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', 'bf1', 'bf2')])!;
	const innerHtml = `<p data-bfid="bf0">Hello <!--bfid:bf1-->World<!--bfid:bf2-->!</p>`;
	const { host, instance, restore } = mount(js, 'my-widget', 'BackflipMyWidget', 'name="World"', innerHtml);
	try {
		const p = host.querySelector('p')!;
		assertEquals(p.textContent, 'Hello World!');

		host.setAttribute('name', 'Mars');
		instance.update('name');
		assertEquals(p.textContent, 'Hello Mars!');

		// Markers survive, so repeated updates keep working.
		const comments = [...p.childNodes].filter((n: any) => n.nodeType === 8).map((n: any) => n.nodeValue);
		assertEquals(comments, ['bfid:bf1', 'bfid:bf2']);

		host.setAttribute('name', '');
		instance.update('name');
		assertEquals(p.textContent, 'Hello !');
	} finally {
		restore();
	}
});

Deno.test("exec: print directly in the custom element patches host children (this.ce)", () => {
	const js = generateClassForPartial('my-thing', [{ name: 'label', isBool: false }],
		[printSite({ kind: 'this-element' }, 'label', 'bf0', 'bf1')])!;
	const innerHtml = `<!--bfid:bf0-->one<!--bfid:bf1-->`;
	const { host, instance, restore } = mount(js, 'my-thing', 'BackflipMyThing', 'label="one"', innerHtml);
	try {
		assertEquals(host.textContent, 'one');
		host.setAttribute('label', 'two');
		instance.update('label');
		assertEquals(host.textContent, 'two');
	} finally {
		restore();
	}
});

Deno.test("exec: inserted value is text, never interpreted as HTML", () => {
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }],
		[printSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', 'bf1', 'bf2')])!;
	const innerHtml = `<p data-bfid="bf0"><!--bfid:bf1-->plain<!--bfid:bf2--></p>`;
	const { host, instance, restore } = mount(js, 'my-widget', 'BackflipMyWidget', 'name="plain"', innerHtml);
	try {
		const p = host.querySelector('p')!;
		host.setAttribute('name', '<b>x</b>');
		instance.update('name');
		assertEquals(p.querySelector('b'), null);          // not parsed as markup
		assertEquals(p.textContent, '<b>x</b>');           // literal text
	} finally {
		restore();
	}
});

Deno.test("exec: a print and an attr on the same element update together", () => {
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], [
		attrSite('bf0', 'title', 'name'),
		printSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', 'bf1', 'bf2'),
	])!;
	const innerHtml = `<p data-bfid="bf0" title="World">Hi <!--bfid:bf1-->World<!--bfid:bf2--></p>`;
	const { host, instance, restore } = mount(js, 'my-widget', 'BackflipMyWidget', 'name="World"', innerHtml);
	try {
		const p = host.querySelector('p')!;
		host.setAttribute('name', 'Mars');
		instance.update('name');
		assertEquals(p.getAttribute('title'), 'Mars');
		assertEquals(p.textContent, 'Hi Mars');
	} finally {
		restore();
	}
});

Deno.test("exec: missing markers log an error and skip without throwing", () => {
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }],
		[printSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', 'bf1', 'bf2')])!;
	// <p> has the bfid but no marker comments (rendered DOM diverged from template).
	const { host, instance, restore } = mount(js, 'my-widget', 'BackflipMyWidget', 'name="World"', `<p data-bfid="bf0">Hello !</p>`);
	const errors: unknown[][] = [];
	const prevErr = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		host.setAttribute('name', 'Mars');
		instance.update('name'); // must not throw
		assertEquals(errors.length, 1);
		assertEquals(String(errors[0][0]).includes('comment markers not found'), true);
	} finally {
		console.error = prevErr;
		restore();
	}
});
