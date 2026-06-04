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

Deno.test("creating a missing template directory emits a config event", async () => {
	// The template root may not exist yet when watching starts (e.g. it was just
	// renamed away). Once it is (re)created the watcher must emit a `config` event
	// so the config is reloaded — clearing the root "directory not found" error —
	// and the templates get compiled.
	const dir = await Deno.makeTempDir();
	const templateDir = `${dir}/templates`; // intentionally not created yet

	const { callback, promise, cleanup } = waitFor(3000);
	const watcher = createWatcher({ templateRoot: templateDir, debounceMs: 50 }, callback);

	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.mkdir(templateDir);
		const events = await promise;
		assertEquals(events.includes('config'), true, 'should receive config event when template dir is created');
	} finally {
		cleanup();
		watcher.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("renaming the template directory away then back is detected", async () => {
	// Removing the template root re-targets the watch to the parent; both the
	// removal and the re-creation are existence changes, so each emits `config`.
	const dir = await Deno.makeTempDir();
	const templateDir = `${dir}/templates`;
	await Deno.mkdir(templateDir);
	await Deno.writeTextFile(`${templateDir}/a.html`, '<div>a</div>');

	// First watcher instance: observe the rename-away.
	const first = waitFor(3000);
	const w1 = createWatcher({ templateRoot: templateDir, debounceMs: 50 }, first.callback);
	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.rename(templateDir, `${dir}/templatesZZZ`);
		const away = await first.promise;
		first.cleanup();
		assertEquals(away.includes('config'), true, 'removal should emit config');
	} finally {
		w1.close();
	}

	// Second watcher instance: observe the dir being created back.
	const second = waitFor(3000);
	const w2 = createWatcher({ templateRoot: templateDir, debounceMs: 50 }, second.callback);
	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.mkdir(templateDir);
		const back = await second.promise;
		second.cleanup();
		assertEquals(back.includes('config'), true, 're-creation should emit config');
	} finally {
		w2.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("renaming a watched asset directory emits a config event", async () => {
	// When an asset directory referenced by backflip.json is renamed (or
	// deleted), the directory it points at no longer exists. The watcher must
	// surface this as a `config` change so consumers reload and re-validate the
	// config, reporting that the referenced directory is missing — rather than a
	// plain `asset` event that only triggers a recompile.
	const dir = await Deno.makeTempDir();
	const assetDir = `${dir}/assets`;
	await Deno.mkdir(assetDir);
	await Deno.writeTextFile(`${assetDir}/styles.css`, 'body { color: red; }');
	const templateDir = `${dir}/templates`;
	await Deno.mkdir(templateDir);

	const { callback, promise, cleanup } = waitFor(3000);
	const watcher = createWatcher({ templateRoot: templateDir, assetDirs: [assetDir], debounceMs: 50 }, callback);

	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.rename(assetDir, `${dir}/assetsZZZ`);
		const events = await promise;
		assertEquals(events.includes('config'), true, 'should receive config event when asset dir disappears');
	} finally {
		cleanup();
		watcher.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("creating a missing asset directory emits a config event", async () => {
	// The asset dir referenced by backflip.json may not exist yet (e.g. it was
	// just renamed away). Once it is (re)created the watcher must surface a
	// `config` change so the config reloads, clears the "directory not found"
	// error, and starts watching the directory's contents.
	const dir = await Deno.makeTempDir();
	const assetDir = `${dir}/assets`; // intentionally not created yet
	const templateDir = `${dir}/templates`;
	await Deno.mkdir(templateDir);

	const { callback, promise, cleanup } = waitFor(3000);
	const watcher = createWatcher({ templateRoot: templateDir, assetDirs: [assetDir], debounceMs: 50 }, callback);

	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.mkdir(assetDir);
		const events = await promise;
		assertEquals(events.includes('config'), true, 'should receive config event when asset dir is created');
	} finally {
		cleanup();
		watcher.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("unrelated entries in the asset dir parent do not emit events", async () => {
	// While the configured asset dir is missing, the watcher observes its parent
	// directory. Creating sibling files/dirs that are not the configured asset dir
	// must not trigger any event.
	const dir = await Deno.makeTempDir();
	const assetDir = `${dir}/assets`; // missing
	const templateDir = `${dir}/templates`;
	await Deno.mkdir(templateDir);

	const events: WatchCategory[] = [];
	const watcher = createWatcher({ templateRoot: templateDir, assetDirs: [assetDir], debounceMs: 50 }, (cat) => {
		events.push(cat);
	});

	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.mkdir(`${dir}/unrelated`);
		await Deno.writeTextFile(`${dir}/note.txt`, 'hello');
		await new Promise((r) => setTimeout(r, 400));
		assertEquals(events.length, 0, 'unrelated sibling changes should not fire');
	} finally {
		watcher.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("re-creating the asset dir after removal is detected", async () => {
	// Full lifecycle: a watched asset dir is removed (→ config), then recreated
	// (→ config again). This exercises the tracker re-targeting onto the parent
	// and back down onto the recreated directory.
	const dir = await Deno.makeTempDir();
	const assetDir = `${dir}/assets`;
	await Deno.mkdir(assetDir);
	const templateDir = `${dir}/templates`;
	await Deno.mkdir(templateDir);

	const watcher = createWatcher({ templateRoot: templateDir, assetDirs: [assetDir], debounceMs: 50 }, () => {});
	try {
		await new Promise((r) => setTimeout(r, 100));

		// Removal → config
		const first = waitFor(3000);
		const w1 = createWatcher({ templateRoot: templateDir, assetDirs: [assetDir], debounceMs: 50 }, first.callback);
		await new Promise((r) => setTimeout(r, 100));
		await Deno.remove(assetDir, { recursive: true });
		const removalEvents = await first.promise;
		first.cleanup();
		assertEquals(removalEvents.includes('config'), true, 'removal should emit config');

		// Re-creation → config (same watcher instance, now re-targeted to parent)
		const second = waitFor(3000);
		const w2 = createWatcher({ templateRoot: templateDir, assetDirs: [assetDir], debounceMs: 50 }, second.callback);
		await new Promise((r) => setTimeout(r, 100));
		await Deno.mkdir(assetDir);
		const createEvents = await second.promise;
		second.cleanup();
		assertEquals(createEvents.includes('config'), true, 're-creation should emit config');

		w1.close();
		w2.close();
	} finally {
		watcher.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("creating a deeply-nested missing asset directory is detected", async () => {
	// The configured asset dir may be several levels below the nearest existing
	// directory. The tracker should walk the watch down as intermediate dirs are
	// created and emit `config` once the full path exists.
	const dir = await Deno.makeTempDir();
	const assetDir = `${dir}/a/b/c`; // none of a, b, c exist yet
	const templateDir = `${dir}/templates`;
	await Deno.mkdir(templateDir);

	const { callback, promise, cleanup } = waitFor(4000);
	const watcher = createWatcher({ templateRoot: templateDir, assetDirs: [assetDir], debounceMs: 50 }, callback);

	try {
		await new Promise((r) => setTimeout(r, 100));
		await Deno.mkdir(`${dir}/a`);
		await new Promise((r) => setTimeout(r, 120));
		await Deno.mkdir(`${dir}/a/b`);
		await new Promise((r) => setTimeout(r, 120));
		await Deno.mkdir(`${dir}/a/b/c`);
		const events = await promise;
		assertEquals(events.includes('config'), true, 'should emit config once the full nested path exists');
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
