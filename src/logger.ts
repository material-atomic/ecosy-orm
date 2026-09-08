/**
 * Where this package's diagnostics go.
 *
 * Not a driver concern: an application has one logger regardless of which
 * engine is installed, so this is a module-level seam like {@link currentDialect}
 * rather than another field on {@link Driver}.
 *
 * The shape is `@ecosy/logger`'s `ILogger` narrowed to the three methods used
 * here, and it is a STRUCTURAL type on purpose — an `@ecosy/logger` instance
 * satisfies it with no adapter and no import, so this package keeps its zero
 * dependencies.
 *
 * @example
 * import { Logger } from "@ecosy/logger";
 * const AppLogger = Logger({ standard: "JSON", service: "marketplace" });
 * DataSource.logger(new AppLogger()).entities([…]).initialize(driver);
 */
export interface Logger {
  /** Progress worth seeing on a first run: migrations applied, schemas synced. */
  info(...args: unknown[]): void;

  /**
   * A change to the database nobody wrote by hand — a column renamed, an index
   * recreated, a constraint dropped. Never routine, and the only record that a
   * column went away.
   */
  warn(...args: unknown[]): void;

  /** Something failed. The cause follows the message. */
  error(...args: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
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
