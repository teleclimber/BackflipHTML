import type { CompiledFile, TNode, ElementTNode, AttrPart, CustomElementCallTNode, RootTNode, CustomElementPartialRoot } from '@backflip/html';
import { parseAssetRef } from '@backflip/html';
import type { AssetReference } from './types.js';
import { collectCssAssetReferences } from './css-references.js';

/**
 * Collect all asset references from both compiled templates and CSS files.
 */
export function collectAllAssetReferences(
	files: Map<string, CompiledFile>,
	assetDirs?: Map<string, string>,
): AssetReference[] {
	const templateRefs = collectAssetReferences(files);
	if (!assetDirs) return templateRefs;

	const cssRefs = collectCssAssetReferences(assetDirs);
	return [...templateRefs, ...cssRefs];
}

/**
 * Walk Phase 1 (unresolved) compiled files and collect all static asset references.
 * Reads `asset` AttrParts from ElementTNode.attrs, custom-element callerAttrs/definitionAttrs.
 */
export function collectAssetReferences(
	files: Map<string, CompiledFile>,
): AssetReference[] {
	const refs: AssetReference[] = [];
	for (const [filePath, compiled] of files) {
		for (const [partialName, root] of compiled.partials) {
			walkRoot(root, filePath, partialName, refs);
		}
	}
	return refs;
}

function walkRoot(root: RootTNode, sourceFile: string, partialName: string, out: AssetReference[]): void {
	walkTNodes(root.tnodes, sourceFile, partialName, out);
	if (root.kind === 'custom-element') {
		const cer = root as CustomElementPartialRoot;
		if (cer.definitionAttrs) collectFromAttrParts(cer.definitionAttrs, sourceFile, partialName, out);
		// b-script entry scripts are stored as unresolved @name/... paths; validate they exist on disk.
		for (const script of cer.scripts ?? []) {
			const ref = parseAssetRef(script.url);
			if (!ref) continue;  // already-resolved (absolute) dependency URLs aren't asset refs
			out.push({
				sourceFile,
				partialName,
				line: 0,
				column: 0,
				assetName: ref.name,
				assetSubpath: ref.subpath,
			});
		}
	}
}

function walkTNodes(
	tnodes: TNode[],
	sourceFile: string,
	partialName: string,
	out: AssetReference[],
): void {
	for (const node of tnodes) {
		switch (node.type) {
			case 'element':
				collectFromAttrParts((node as ElementTNode).attrs, sourceFile, partialName, out);
				walkTNodes((node as ElementTNode).tnodes, sourceFile, partialName, out);
				break;
			case 'for':
				walkTNodes(node.tnodes, sourceFile, partialName, out);
				break;
			case 'if':
				for (const branch of node.branches) {
					walkTNodes(branch.tnodes, sourceFile, partialName, out);
				}
				break;
			case 'partial-ref':
				if (node.kind === 'custom-element') {
					const cec = node as CustomElementCallTNode;
					if (cec.callerAttrs) collectFromAttrParts(cec.callerAttrs, sourceFile, partialName, out);
				}
				for (const slotTNodes of Object.values(node.slots)) {
					walkTNodes(slotTNodes, sourceFile, partialName, out);
				}
				break;
		}
	}
}

function collectFromAttrParts(
	parts: AttrPart[],
	sourceFile: string,
	partialName: string,
	out: AssetReference[],
): void {
	for (const part of parts) {
		if (part.type === 'asset') {
			for (const ref of part.refs) {
				out.push({
					sourceFile,
					partialName,
					line: ref.loc?.startLine ?? part.loc?.startLine ?? 0,
					column: ref.loc?.startCol ?? part.loc?.startCol ?? 0,
					endLine: ref.loc?.endLine,
					endColumn: ref.loc?.endCol,
					subpathLine: ref.subpathLoc?.startLine,
					subpathColumn: ref.subpathLoc?.startCol,
					subpathEndLine: ref.subpathLoc?.endLine,
					subpathEndColumn: ref.subpathLoc?.endCol,
					assetName: ref.name,
					assetSubpath: ref.subpath,
				});
			}
		}
	}
}
