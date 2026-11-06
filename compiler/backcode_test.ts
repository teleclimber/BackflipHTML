import { assertEquals } from "jsr:@std/assert";
import { interpretBackcode, visitBackcode, type BackcodeVisitor } from "./backcode.ts";

Deno.test("interpretBackcode: allowed unary operators produce no errors", () => {
	["!abc", "-abc", "+abc", "!!abc", "!abc.def"].forEach(s => {
		const result = interpretBackcode(s);
		assertEquals(result.errs, [], `expected no errors for: ${s}`);
	});
});

Deno.test("interpretBackcode: disallowed unary operators produce errors", () => {
	["typeof abc", "void abc", "delete abc"].forEach(s => {
		const result = interpretBackcode(s);
		assertEquals(result.errs.length > 0, true, `expected error for: ${s}`);
	});
});

Deno.test("interpretBackcode: ternary expression", () => {
	const result = interpretBackcode('a ? b : c');
	assertEquals(result.errs, []);
	assertEquals(result.vars, ['a', 'b', 'c']);
});

Deno.test("interpretBackcode: ternary with member access", () => {
	const result = interpretBackcode('a ? b.c : d[e]');
	assertEquals(result.errs, []);
	assertEquals(result.vars, ['a', 'b', 'd', 'e']);
});

Deno.test("interpretBackcode: equality operators", () => {
	(['==', '!='] as const).forEach(op => {
		const result = interpretBackcode(`a ${op} b`);
		assertEquals(result.errs, [], `expected no errors for: a ${op} b`);
		assertEquals(result.vars, ['a', 'b']);
	});
});

Deno.test("interpretBackcode: equality with member access on both sides", () => {
	const result = interpretBackcode('a.x == b[c]');
	assertEquals(result.errs, []);
	assertEquals(result.vars, ['a', 'b', 'c']);
});

Deno.test("interpretBackcode: equality composes with unary and ternary", () => {
	const negated = interpretBackcode('!(a == b)');
	assertEquals(negated.errs, []);
	assertEquals(negated.vars, ['a', 'b']);

	const ternary = interpretBackcode('a == b ? c : d');
	assertEquals(ternary.errs, []);
	assertEquals(ternary.vars, ['a', 'b', 'c', 'd']);
});

Deno.test("interpretBackcode: plus operator", () => {
	const result = interpretBackcode('a + b');
	assertEquals(result.errs, []);
	assertEquals(result.vars, ['a', 'b']);

	const literals = interpretBackcode("'abc' + 'def'");
	assertEquals(literals.errs, []);
	assertEquals(literals.vars, []);

	const mixed = interpretBackcode("'prefix' + name");
	assertEquals(mixed.errs, []);
	assertEquals(mixed.vars, ['name']);

	const chained = interpretBackcode('a + b + c');
	assertEquals(chained.errs, []);
	assertEquals(chained.vars, ['a', 'b', 'c']);
});

Deno.test("interpretBackcode: relational operators", () => {
	(['<', '>', '<=', '>='] as const).forEach(op => {
		const result = interpretBackcode(`a ${op} b`);
		assertEquals(result.errs, [], `expected no errors for: a ${op} b`);
		assertEquals(result.vars, ['a', 'b']);
	});
});

Deno.test("interpretBackcode: relational composes with member access and ternary", () => {
	const member = interpretBackcode('a.x < b[c]');
	assertEquals(member.errs, []);
	assertEquals(member.vars, ['a', 'b', 'c']);

	const ternary = interpretBackcode('a >= b ? c : d');
	assertEquals(ternary.errs, []);
	assertEquals(ternary.vars, ['a', 'b', 'c', 'd']);
});

Deno.test("interpretBackcode: disallowed binary operators produce errors", () => {
	['a === b', 'a !== b', 'a && b', 'a || b'].forEach(s => {
		const result = interpretBackcode(s);
		assertEquals(result.errs.length > 0, true, `expected error for: ${s}`);
	});
});
// Names each node the visitor reaches, in visiting order.
const namer: BackcodeVisitor<string> = {
	Identifier: (n) => `Identifier(${n.name})`,
	Literal: (n) => `Literal(${n.raw})`,
	MemberExpression: (n) => `Member(${visitBackcode(n.object, namer)})`,
	UnaryExpression: (n) => `Unary(${visitBackcode(n.argument, namer)})`,
	ConditionalExpression: (n) => `Conditional(${visitBackcode(n.test, namer)})`,
	BinaryExpression: (n) => `Binary(${visitBackcode(n.left, namer)}, ${visitBackcode(n.right, namer)})`,
	unsupported: (n) => `unsupported(${n.type})`,
};

function nameOf(code: string): string {
	return visitBackcode(interpretBackcode(code).expr!.expression, namer);
}

Deno.test("visitBackcode: dispatches each backcode node to its handler", () => {
	assertEquals(nameOf('a'), 'Identifier(a)');
	assertEquals(nameOf('"s"'), 'Literal("s")');
	assertEquals(nameOf('a.b'), 'Member(Identifier(a))');
	assertEquals(nameOf('!a'), 'Unary(Identifier(a))');
	assertEquals(nameOf('a ? b : c'), 'Conditional(Identifier(a))');
	assertEquals(nameOf('a + 1'), 'Binary(Identifier(a), Literal(1))');
});

Deno.test("visitBackcode: other nodes go to unsupported", () => {
	assertEquals(nameOf('a && b'), 'unsupported(LogicalExpression)');
	assertEquals(nameOf('f(a)'), 'unsupported(CallExpression)');
	assertEquals(nameOf('a + (b = 1)'), 'Binary(Identifier(a), unsupported(AssignmentExpression))');
});

Deno.test("visitBackcode: extra arguments reach every handler", () => {
	const depth: BackcodeVisitor<number, [d: number]> = {
		Identifier: (_n, d) => d,
		Literal: (_n, d) => d,
		MemberExpression: (n, d) => visitBackcode(n.object, depth, d + 1),
		UnaryExpression: (n, d) => visitBackcode(n.argument, depth, d + 1),
		ConditionalExpression: (n, d) => visitBackcode(n.test, depth, d + 1),
		BinaryExpression: (n, d) => Math.max(visitBackcode(n.left, depth, d + 1), visitBackcode(n.right, depth, d + 1)),
		unsupported: (_n, d) => d,
	};
	assertEquals(visitBackcode(interpretBackcode('!(a.b + 1)').expr!.expression, depth, 0), 3);
});

Deno.test("BackcodeVisitor: a visitor missing a node handler is a type error", () => {
	// @ts-expect-error BinaryExpression has no handler
	const partial: BackcodeVisitor<void> = {
		Identifier() {},
		Literal() {},
		MemberExpression() {},
		UnaryExpression() {},
		ConditionalExpression() {},
		unsupported() {},
	};
	assertEquals(typeof partial.unsupported, 'function');
});
