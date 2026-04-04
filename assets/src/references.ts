import type { CompiledFile, TNode, AssetRefTNode, AttrBindTNode } from '@backflip/html';
import type { AssetReference } from './types.js';

/**
 * Walk Phase 1 (unresolved) compiled files and collect all static asset references.
 * Reads AssetRefTNode nodes and { type: 'asset' } AttrParts from the AST.
 */
export function collectAssetReferences(
	files: Map<string, CompiledFile>,
): AssetReference[] {
	const refs: AssetReference[] = [];
	for (const [filePath, compiled] of files) {
		for (const [partialName, root] of compiled.partials) {
			walkTNodes(root.tnodes, filePath, partialName, refs);
		}
	}
	return refs;
}

function walkTNodes(
	tnodes: TNode[],
	templateFile: string,
	partialName: string,
	out: AssetReference[],
): void {
	for (const node of tnodes) {
		switch (node.type) {
			case 'asset-ref':
				collectFromAssetRef(node, templateFile, partialName, out);
				break;
			case 'attr-bind':
				collectFromAttrBind(node, templateFile, partialName, out);
				break;
			case 'for':
				walkTNodes(node.tnodes, templateFile, partialName, out);
				break;
			case 'if':
				for (const branch of node.branches) {
					walkTNodes(branch.tnodes, templateFile, partialName, out);
				}
				break;
			case 'partial-ref':
				for (const slotTNodes of Object.values(node.slots)) {
					walkTNodes(slotTNodes, templateFile, partialName, out);
				}
				break;
		}
	}
}

function collectFromAssetRef(
	node: AssetRefTNode,
	templateFile: string,
	partialName: string,
	out: AssetReference[],
): void {
	for (const ref of node.refs) {
		out.push({
			templateFile,
			partialName,
			line: node.loc?.startLine ?? 0,
			column: node.loc?.startCol ?? 0,
			assetName: ref.name,
			assetSubpath: ref.subpath,
		});
	}
}

function collectFromAttrBind(
	node: AttrBindTNode,
	templateFile: string,
	partialName: string,
	out: AssetReference[],
): void {
	for (const part of node.parts) {
		if (part.type === 'asset') {
			for (const ref of part.refs) {
				out.push({
					templateFile,
					partialName,
					line: part.loc?.startLine ?? 0,
					column: part.loc?.startCol ?? 0,
					assetName: ref.name,
					assetSubpath: ref.subpath,
				});
			}
		}
	}
}
