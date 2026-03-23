import { createPgStore } from "./pgStore.js";

export function createStore({ pool }) {
  if (!pool) {
    throw new Error("Database pool not configured");
  }
  return createPgStore(pool);
}
