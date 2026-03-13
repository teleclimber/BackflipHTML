import type { Parsed } from './backcode.ts';
import * as acorn from 'npm:acorn';

export function generateFunction(name:string, parsed :Parsed) :string {
	return `function ${name}( ${parsed.vars.join(", ")} ) { return ${generateStatement(parsed.expr!)}; }`;
}
export function generateStatement(node :acorn.ExpressionStatement) :string {
	return generateNode(node.expression);
}

function generateNode(node:acorn.AnyNode) :string {
	switch (node.type) {
		case 'Identifier':
			return node.name;
		case 'Literal':
			return node.raw!;	// there should be a raw!
		case 'MemberExpression':
			return generateMemberExpression(node);
		default:
			throw new Error(`invalid node: ${node.type}`);
	}
}

function generateMemberExpression(node:acorn.MemberExpression) :string {
	if( node.computed ) {
		return generateNode(node.object) + '['+generateNode(node.property)+']';
	} else {
		return generateNode(node.object) + '.' + generateNode(node.property);
	}
}