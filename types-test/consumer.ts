/**
 * The public API, used the way a project with `exactOptionalPropertyTypes`
 * uses it.
 *
 * Type-level only — nothing here runs, and nothing connects. It exists because
 * the package compiling under the flag proves only that its own code is
 * consistent; whether a *caller* under the flag can pass an ordinary
 * maybe-absent value is a different question, and the answer used to be no.
 *
 * Every statement below failed before `./src/optional`. Keep them.
 */

import {
  Entity, Repository,
  type FindOptions, type PartialInput,
} from "../src/index";
import { PgDriver } from "../src/drivers/pg";

const UserEntity = Entity.create("users", {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true },
    name: { type: "TEXT", notNull: true },
    nickname: { type: "TEXT" },
  },
} as const);

type User = InstanceType<typeof UserEntity>;

class UserRepository extends Repository<User> {
  constructor() {
    super(UserEntity);
  }
}

const repo = new UserRepository();

declare const maybeText: string | undefined;
declare const maybeNumber: number | undefined;

/* A column computed as maybe-absent. The everyday case: a field that is only
   set for some kinds of row. */
export const inserted = repo.insert({ id: "x", name: "n", nickname: maybeText });

/* The same, in bulk. */
export const insertedMany = repo.insert([{ name: "n", nickname: maybeText }]);

/* Paging built from a query string, where both are optional. */
export const found = repo.find({ where: { name: "n" }, limit: maybeNumber, offset: maybeNumber });

/* A patch assembled elsewhere and spread in — the shape a request handler
   builds before it knows which fields were sent. */
declare const patch: { nickname?: string | undefined; name?: string | undefined };
export const updated = repo.update({ id: "x" }, patch);

export const upserted = repo.upsert({ id: "x", nickname: maybeText }, ["id"]);

/* Options held in a variable rather than written at the call site. */
const options: FindOptions<User> = { limit: maybeNumber };
export const paged = repo.find(options);

/* Driver config assembled from the environment, where everything is
   `string | undefined`. */
export const driver = PgDriver({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

/* An entity option literal with a value that may not be there. */
declare const maybeFlag: boolean | undefined;
export const Flexible = Entity.create("flexible", {
  columns: { id: { type: "UUID", primaryKey: true, notNull: maybeFlag } },
});

/* The helper is exported, so a project can type its own layer the same way. */
export type UserPatch = PartialInput<User>;

/* Moved off DataSource to break the data-source ↔ repository cycle. */
import { createRepository } from "../src/index";
export const dynamic = createRepository(UserEntity);
