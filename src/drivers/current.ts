import type { Dialect, Driver } from "./types";

/**
 * The installed driver, held on `globalThis`.
 *
 * A module-scope variable is not enough. A bundler gives different layers of
 * an application their own copy of a module — in Next, instrumentation and a
 * route handler are separate graphs — so a driver registered at startup would
 * be invisible to the code that serves requests, and every query would report
 * that no driver was installed. A `Symbol.for` key is shared across copies,
 * and survives a hot reload for the same reason.
 */
const KEY = Symbol.for("@ecosy/orm:driver");

const store = globalThis as typeof globalThis & { [KEY]?: Driver };

/** Records the driver. Called by `DataSource.driver`. */
export function setDriver(driver: Driver) {
  store[KEY] = driver;
}

/** The installed driver. */
export function currentDriver(): Driver {
  if (!store[KEY]) {
    throw new Error(
      "No driver installed. Call DataSource.driver(PgDriver({ … })) before initialize().",
    );
  }
  return store[KEY];
}

/** The installed driver's dialect. */
export function currentDialect(): Dialect {
  return currentDriver().dialect;
}
