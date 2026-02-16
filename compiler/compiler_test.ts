import { assertEquals } from "jsr:@std/assert";

import type { RootTNode, RawTNode } from "./compiler.ts";
import { onText, pushRaw } from "./compiler.ts";
import { interpretBackcode } from "./backcode.ts";

Deno.test( "pushRaw", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: 'hello', parent: root	};
	root.tnodes.push(child_node);

	const ret_node = pushRaw(root.tnodes[0], "world");
	const ret_raw = ret_node.type === 'raw' ? ret_node.raw : '';
	assertEquals(ret_raw, 'helloworld');
});

Deno.test( "onText-Raw", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], 'world');

	assertEquals(root, {
		type: 'root',
		tnodes: [{
			type: 'raw',
			raw: 'world',
			parent: root
		}]
	});
});

Deno.test( "onText-PrintOne", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], '{{ g }}');

	assertEquals(root, {
		type: 'root',
		tnodes: [{
			type: 'raw',
			raw: '',
			parent: root
		}, {
			type: 'print',
			data: interpretBackcode('g'),
			parent: root
		}]
	});
});

Deno.test( "onText-Raw+PrintOne", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], 'hello {{ g }}');

	assertEquals(root, {
		type: 'root',
		tnodes: [{
			type: 'raw',
			raw: 'hello ',
			parent: root
		}, {
			type: 'print',
			data: interpretBackcode('g'),
			parent: root
		}]
	});
});

Deno.test( "onText-Raw+PrintOne+Raw", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], 'hello {{ g }} world');

	assertEquals(root, {
		type: 'root',
		tnodes: [{
			type: 'raw',
			raw: 'hello ',
			parent: root
		}, {
			type: 'print',
			data: interpretBackcode('g'),
			parent: root
		}, {
			type: 'raw',
			raw: ' world',
			parent: root
		}]
	});
});


Deno.test( "onText-Raw+PrintTwo+Raw", () => {
	const root :RootTNode = { type: 'root', tnodes: [] };
	const child_node :RawTNode = { type: 'raw', raw: '', parent: root	};
	root.tnodes.push(child_node);

	onText(root.tnodes![0], 'hello {{ g }}{{ k }} world');

	assertEquals(root, {
		type: 'root',
		tnodes: [{
			type: 'raw',
			raw: 'hello ',
			parent: root
		}, {
			type: 'print',
			data: interpretBackcode('g'),
			parent: root
		}, {
			type: 'print',
			data: interpretBackcode('k'),
			parent: root
		}, {
			type: 'raw',
			raw: ' world',
			parent: root
		}]
	});

	console.log(root);
});