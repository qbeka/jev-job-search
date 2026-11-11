/**
 * Keeps, reads back, replaces and removes one made-up item in this machine's own secret store:
 * the Keychain, the Linux keyring or Windows Credential Manager. Run on purpose, by CI on each
 * system: `npx tsx tests/helpers/realStore.ts`. It touches nothing but the item it makes.
 */
import { defaultStore, storeKind } from "../../src/accounts/secrets.js";
import { Secret } from "../../src/util/redact.js";

const kind = storeKind();
if (kind === "env") throw new Error("this machine has no secret store to check");
const store = defaultStore();
const name = `test-item-${process.pid}`;
const first = `Made-up-${process.pid}!x9`;
const second = `${first}-second`;
const started = Date.now();
const must = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`${kind}: ${what}`);
};
try {
  must(store.get(name) === null, "an item that was never stored came back");
  store.set(name, new Secret(first));
  must(store.get(name)?.reveal() === first, "the stored value did not come back as it went in");
  store.set(name, new Secret(second));
  must(store.get(name)?.reveal() === second, "a second value did not replace the first");
} finally {
  store.delete(name);
}
must(store.get(name) === null, "the item was still there after it was removed");
console.log(`${kind}: kept, returned, replaced and forgot a value in ${((Date.now() - started) / 1000).toFixed(1)}s`);
