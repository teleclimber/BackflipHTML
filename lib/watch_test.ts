import { assertEquals } from "@std/assert";
import { createWatcher, type WatchCategory } from "./watch.ts";

/** Wait for `callback` to be called, or time out after `ms`. */
function waitFor(ms: number): { callback: (cat: WatchCategory) => void; promise: Promise<WatchCategory[]>; cleanup: () => void } {
	const events: WatchCategory[] = [];
	let resolve: (v: WatchCategory[]) => void;
	const promise = new Promise<WatchCategory[]>((r) => { resolve = r; });
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let failsafeTimer: ReturnType<typeof setTimeout> | undefined;

	const callback = (cat: WatchCategory) => {
		events.push(cat);
		if (settleTimer !== undefined) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => resolve(events), 100);
	};

	failsafeTimer = setTimeout(() => resolve(events), ms);

	const cleanup = () => {
		if (settleTimer !== undefined) clearTimeout(settleTimer);
		if (failsafeTimer !== undefined) clearTimeout(failsafeTimer);
	};

	return { callback, promise, cleanup };
}

Deno.test("watches .html files in template root", async () => {
	const dir = await Deno.makeTempDir();
	const htmlFile = `${dir}/test.html`;
	await Deno.writeTextFile(htmlFile, '<div>hello</div>');

	const { callback, promise, cleanup } = waitFor(3000);
	const watcher = createWatcher({ templateRoot: dir, debounceMs: 50 }, callback);

	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.writeTextFile(htmlFile, '<div>changed</div>');
		const events = await promise;
		assertEquals(events.length > 0, true, 'should receive template event');
		assertEquals(events[0], 'template');
	} finally {
		cleanup();
		watcher.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("ignores non-.html files in template root", async () => {
	const dir = await Deno.makeTempDir();
	const jsFile = `${dir}/test.js`;
	await Deno.writeTextFile(jsFile, 'console.log("hi")');

	const events: WatchCategory[] = [];
	const watcher = createWatcher({ templateRoot: dir, debounceMs: 50 }, (cat) => {
		events.push(cat);
	});

	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.writeTextFile(jsFile, 'console.log("changed")');
		await new Promise((r) => setTimeout(r, 400));
		assertEquals(events.length, 0, 'should not fire for non-.html files');
	} finally {
		watcher.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("watches CSS file in asset directory", async () => {
	const dir = await Deno.makeTempDir();
	const assetDir = `${dir}/assets`;
	await Deno.mkdir(assetDir);
	const cssFile = `${assetDir}/styles.css`;
	await Deno.writeTextFile(cssFile, 'body { color: red; }');
	const templateDir = `${dir}/templates`;
	await Deno.mkdir(templateDir);

	const { callback, promise, cleanup } = waitFor(3000);
	const watcher = createWatcher({ templateRoot: templateDir, assetDirs: [assetDir], debounceMs: 50 }, callback);

	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.writeTextFile(cssFile, 'body { color: blue; }');
		const events = await promise;
		assertEquals(events.length > 0, true, 'should receive asset event for CSS change');
		assertEquals(events[0], 'asset');
	} finally {
		cleanup();
		watcher.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("watches config file", async () => {
	const dir = await Deno.makeTempDir();
	const configFile = `${dir}/backflip.json`;
	await Deno.writeTextFile(configFile, '{"root":"src"}');
	const templateDir = `${dir}/templates`;
	await Deno.mkdir(templateDir);

	const { callback, promise, cleanup } = waitFor(3000);
	const watcher = createWatcher({ templateRoot: templateDir, configPath: configFile, debounceMs: 50 }, callback);

	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.writeTextFile(configFile, '{"root":"dist"}');
		const events = await promise;
		assertEquals(events.length > 0, true, 'should receive config event');
		assertEquals(events[0], 'config');
	} finally {
		cleanup();
		watcher.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("close stops callbacks", async () => {
	const dir = await Deno.makeTempDir();
	const htmlFile = `${dir}/test.html`;
	await Deno.writeTextFile(htmlFile, '<div>hello</div>');

	const events: WatchCategory[] = [];
	const watcher = createWatcher({ templateRoot: dir, debounceMs: 50 }, (cat) => {
		events.push(cat);
	});

	try {
		await new Promise((r) => setTimeout(r, 100));
		watcher.close();
		await Deno.writeTextFile(htmlFile, '<div>changed</div>');
		await new Promise((r) => setTimeout(r, 400));
		assertEquals(events.length, 0, 'should not fire after close');
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("debounces rapid changes", async () => {
	const dir = await Deno.makeTempDir();
	const htmlFile = `${dir}/test.html`;
	await Deno.writeTextFile(htmlFile, '<div>hello</div>');

	const { callback, promise, cleanup } = waitFor(3000);
	const watcher = createWatcher({ templateRoot: dir, debounceMs: 200 }, callback);

	try {
		await new Promise((r) => setTimeout(r, 100));
		for (let i = 0; i < 5; i++) {
			await Deno.writeTextFile(htmlFile, `<div>change ${i}</div>`);
			await new Promise((r) => setTimeout(r, 20));
		}
		const events = await promise;
		assertEquals(events.length, 1, 'rapid changes should be debounced to single event');
		assertEquals(events[0], 'template');
	} finally {
		cleanup();
		watcher.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});
