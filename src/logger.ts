/**
 * Where this package's diagnostics go.
 *
 * Not a driver concern: an application has one logger regardless of which
 * engine is installed, so this is a module-level seam like {@link currentDialect}
 * rather than another field on {@link Driver}.
 *
 * The default writes to the console, so nothing changes for a project that
 * never installs one. `silentLogger` is there for tests and for a build whose
 * bundler drops console calls anyway.
 */
export interface Logger {
  /** Progress worth seeing on a first run: migrations applied, schemas synced. */
  info(message: string, meta?: unknown): void;

  /**
   * A change to the database the caller did not write by hand — a column
   * renamed, an index recreated, a constraint dropped. Never routine.
   */
  warn(message: string, meta?: unknown): void;

  /** Something failed. `error` carries the cause. */
  error(message: string, error?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (message, meta) => (meta === undefined ? console.log(message) : console.log(message, meta)),
  warn: (message, meta) => (meta === undefined ? console.warn(message) : console.warn(message, meta)),
  error: (message, error) =>
    error === undefined ? console.error(message) : console.error(message, error),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let installed: Logger = consoleLogger;

/** Installs a logger. Called through {@link DataSource.logger}. */
export function setLogger(logger: Logger) {
  installed = logger ?? consoleLogger;
}

/** The installed logger. Read at call time, so installing later still applies. */
export function currentLogger(): Logger {
  return installed;
}
