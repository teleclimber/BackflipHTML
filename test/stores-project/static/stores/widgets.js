import { BackflipStore } from '../bfdom/runtime/dom-patch/stores.js';

class Widgets extends BackflipStore {
	ownedBy(owner) { return Object.values(this.data).filter((w) => w.owner === owner); }
}

export default new Widgets('widgets');
