// Shared helpers for the CSS test suites. Not part of the package's public API
// and not reachable from `index.ts`, so the analyzer itself keeps no runtime
// dependency on the compiler — only these helpers do, to turn template sources
// into the compiled trees `analyzeCss` matches against.
//
// `@backflip/html` resolves to the built `dist/`, so run `npm run build` at the
// repo root before the CSS tests (the integration suite already requires it).

import { compileFiles } from '@backflip/html';
import type { CompiledFile } from '@backflip/html';
import { analyzeCss } from './index.js';
import type { CssAnalysisResult, PartialSourceInfo } from './types.js';

/** Compile template sources, and derive the partial metadata from the result. */
export async function compileTemplates(templateFiles: Map<string, string>): Promise<{
	compiled: Map<string, CompiledFile>;
	partialInfo: Map<string, Map<string, PartialSourceInfo>>;
}> {
	const { directory } = await compileFiles(templateFiles);
	const partialInfo = new Map<string, Map<string, PartialSourceInfo>>();
	for (const [filePath, file] of directory.files) {
		const fileInfo = new Map<string, PartialSourceInfo>();
		for (const [name, root] of file.partials) {
			if (root.meta) fileInfo.set(name, root.meta);
		}
		partialInfo.set(filePath, fileInfo);
	}
	return { compiled: directory.files, partialInfo };
}

/** Compile the given templates and analyze `cssContent` against them. */
export async function analyzeSource(input: {
	cssContent: string;
	templateFiles: Map<string, string>;
}): Promise<CssAnalysisResult> {
	const { compiled, partialInfo } = await compileTemplates(input.templateFiles);
	return analyzeCss({ ...input, partialInfo, compiled });
}
