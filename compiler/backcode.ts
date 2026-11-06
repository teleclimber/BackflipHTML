import * as acorn from 'acorn';

export type Parsed = {
	expr: acorn.ExpressionStatement | undefined,
	errs: string[],
	vars: string[]
}

// --- Backcode node set and visitor ---

// The acorn nodes backcode allows. Every walker over backcode is a
// BackcodeVisitor, so adding a node here is a type error in each walker until
// it handles the new node.
export type BackcodeNode =
	| acorn.Identifier
	| acorn.Literal
	| acorn.MemberExpression
	| acorn.UnaryExpression
	| acorn.ConditionalExpression
	| acorn.BinaryExpression;

type BackcodeNodeType = BackcodeNode['type'];

const BACKCODE_NODE_TYPES: Record<BackcodeNodeType, true> = {
	Identifier: true,
	Literal: true,
	MemberExpression: true,
	UnaryExpression: true,
	ConditionalExpression: true,
	BinaryExpression: true,
};

export function isBackcodeNode(node: acorn.AnyNode): node is BackcodeNode {
	return Object.hasOwn(BACKCODE_NODE_TYPES, node.type);
}

// One handler per backcode node, plus `unsupported` for any other node.
// Expressions with errors still reach the walkers, so each one decides what an
// unsupported node means to it. `A` is the extra arguments every handler takes.
export type BackcodeVisitor<R, A extends unknown[] = []> = {
	[T in BackcodeNodeType]: (node: Extract<BackcodeNode, { type: T }>, ...args: A) => R;
} & {
	unsupported: (node: acorn.AnyNode, ...args: A) => R;
};

export function visitBackcode<R, A extends unknown[]>(
	node: acorn.AnyNode,
	visitor: BackcodeVisitor<R, A>,
	...args: A
): R {
	if (!isBackcodeNode(node)) return visitor.unsupported(node, ...args);
	const handler = visitor[node.type] as (node: BackcodeNode, ...args: A) => R;
	return handler(node, ...args);
}

// --- Parsing and validation ---

export function interpretBackcode(code :string) :Parsed {
	const ret :Parsed = {expr: undefined, errs:[], vars:[]};
	let ast :acorn.Program | undefined;
	try {
		ast = acorn.parse(code, {ecmaVersion: 2020});
	}
	catch (e) {
		console.error(e);
		ret.errs.push(e+'');
		return ret;
	}
	const {expr, err} = getProgramExpression(ast);
	if( err ) ret.errs.push(err);
	if( !expr ) {
		return ret;	// can't continue.
	}
	ret.expr = expr;
	const collected :string[] = [];
	visitBackcode(expr.expression, validator, ret.errs, collected);
	ret.vars = [...new Set(collected)];
	return ret;
}

function getProgramExpression(prog :acorn.Program) :{expr: acorn.ExpressionStatement | undefined, err: string|undefined} {
	if( prog.type !== 'Program' ) return {expr:undefined, err:'not aprogram'};
	if( prog.body.length === 0 ) return {expr:undefined, err:'body has no statements in it'};
	const node = prog.body[0];
	if( node.type !== 'ExpressionStatement' ) return {expr:undefined, err:'node is not expression statement. It is '+node.type};
	if( prog.body.length > 1 ) return {expr:node, err:'body has more than one statement in it'};
	return {expr:node, err:undefined};
}

const ALLOWED_BINARY_OPERATORS = new Set(['==', '!=', '+', '<', '>', '<=', '>=']);
const ALLOWED_UNARY_OPERATORS = new Set(['!', '+', '-']);

// Reports disallowed constructs into `errs` and collects free variables into `vars`.
const validator: BackcodeVisitor<void, [errs: string[], vars: string[]]> = {
	Identifier(node, _errs, vars) {
		vars.push(node.name);
	},
	Literal() {},
	MemberExpression(node, errs, vars) {
		visitBackcode(node.object, validator, errs, vars);
		// A non-computed property is a name, not a variable.
		if (node.computed) visitBackcode(node.property, validator, errs, vars);
	},
	UnaryExpression(node, errs, vars) {
		if (!ALLOWED_UNARY_OPERATORS.has(node.operator)) {
			errs.push(`unsupported unary operator: ${node.operator}`);
			return;
		}
		visitBackcode(node.argument, validator, errs, vars);
	},
	ConditionalExpression(node, errs, vars) {
		visitBackcode(node.test, validator, errs, vars);
		visitBackcode(node.consequent, validator, errs, vars);
		visitBackcode(node.alternate, validator, errs, vars);
	},
	BinaryExpression(node, errs, vars) {
		if (!ALLOWED_BINARY_OPERATORS.has(node.operator)) {
			errs.push(`unsupported binary operator: ${node.operator}`);
			return;
		}
		visitBackcode(node.left, validator, errs, vars);
		visitBackcode(node.right, validator, errs, vars);
	},
	unsupported(node, errs) {
		errs.push(`invalid node: ${node.type}`);
	},
};
