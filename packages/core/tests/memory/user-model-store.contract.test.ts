/**
 * Runs the shared {@link UserModelStore} contract against
 * {@link InMemoryUserModelStore}. Always runs; needs no database.
 */

import { InMemoryUserModelStore } from "../../src/memory/user-model.js";
import { runUserModelStoreContract } from "../helpers/user-model-store-contract.js";

runUserModelStoreContract("InMemoryUserModelStore", () =>
  Promise.resolve({
    store: new InMemoryUserModelStore(),
    cleanup: () => Promise.resolve(),
  }),
);
