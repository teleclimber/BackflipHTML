import * as acorn from 'npm:acorn';
//import * as walk from 'npm:acorn-walk';

// what we need to support at a minimum:
// - abc.def
// - abc[ ...recusrive... ]
// - equality [StmtExpr] == [StmtExpr]
// - comparison > <
// - && and || (maybe later)

// nodes we want to interpret correctly:
// - Program (just once at the beginning)
// - ExpressionStatement (just once.)
// - MemberExpression
// - Identifier
// - Literal

export type Parsed = {
	expr: acorn.ExpressionStatement | undefined,
	errs: string[],
	vars: string[]
}

//console.log(acorn.parse("abc.def.hghi", {ecmaVersion: 2020}));

// const result = interpretBackcode("abc.def['adf']");
// console.log(result.vars, result.errs);


export function interpretBackcode(code :string) :Parsed {
	// what we want in return:
	// - ast that can be used to generate code in various languages
	// - validation that nothing disallowed is in there.
	// - list of input vars
	// - maybe expected return value? like bool...?
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
	// walk.full(ast, (node) => {
	// 	console.log("node:", node.type);
	// } );
	const {expr, err} = getProgramExpression(ast);
	if( err ) ret.errs.push(err);
	if( !expr ) {
		return ret;	// can't continue.
	}
	if( expr ) ret.expr = expr;
	interpretNode(expr.expression, true, ret.errs, ret.vars)
	return ret;
}

function getProgramExpression(prog :acorn.Program) :{expr: acorn.ExpressionStatement | undefined, err: string|undefined} {
	if( prog.type !== 'Program' ) return {expr:undefined, err:'not aprogram'};
	if( prog.body.length === 0 ) return {expr:undefined, err:'body has no statements in it'};
	const node = prog.body[0];
	if( node.type !== 'ExpressionStatement' ) return {expr:undefined, err:'node is not expression statement. It is '+node.type};
	if( prog.body.length > 1 ) return {expr:node, err:'body has more than one statement in it'};
	return {expr:node, err:''};
}

function interpretNode(node:acorn.AnyNode, computed: boolean, errs: string[], vars: string[]) {
	switch (node.type) {
		case 'Identifier':
			if( computed ) vars.push(node.name);
			break;
		case 'Literal':
			// nothing to do?
			break;
		case 'MemberExpression':
			interpretMemberExpression(node, computed, errs, vars);
			break;
		default:
			errs.push(`invalid node: ${node.type}`);
			break;
	}
}

function interpretMemberExpression(node:acorn.MemberExpression, computed:boolean, errs: string[], vars: string[]) {
	// object and property..
	interpretNode(node.object, computed, errs, vars);
	interpretNode(node.property, node.computed, errs, vars);
}