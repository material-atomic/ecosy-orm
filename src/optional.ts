/**
 * Types that survive `exactOptionalPropertyTypes`.
 *
 * With that flag on, `{ a?: string }` accepts a missing `a` but rejects
 * `{ a: undefined }` — the two stop being the same thing. That is the point of
 * the flag and it is a good one, but it makes every optional property in a
 * library's *input* types hostile to ordinary code:
 *
 * ```ts
 * const wrapId = isEmbed ? payload.wrapId : undefined;
 * await repo.insert({ name, wrapId });   // string | undefined → rejected
 * ```
 *
 * Nothing is wrong there. The caller computed a value that may be absent and
 * passed it, which is what `undefined` is for, and the library treats a missing
 * key and an undefined one identically — a column set to `undefined` is not
 * written: an insert leaves it to the column's DEFAULT, an update leaves the
 * stored value alone. (Before 1.2.0 this sentence was false. `pg` sends
 * `undefined` as NULL, and an update with `{ code: maybe }` erased the column.)
 *
 * So input types say `| undefined` explicitly. It is not a way around the
 * flag; it is the flag being told the truth about what these functions accept.
 *
 * Output types are left alone. A row that came back is not optional-in-the-
 * caller's-sense, and widening what is returned would push the same problem
 * onto whoever reads it.
 */

/**
 * `Partial<T>` that still accepts an explicit `undefined` per key.
 *
 * `Partial` cannot be used and this is not a matter of taste — see
 * `types-test/why-not-partial.ts`, which asserts it with `@ts-expect-error`.
 * `Partial<{ nickname: string | null }>` is `{ nickname?: string | null }`,
 * and under the flag that set does not contain `undefined`.
 *
 * One name, used everywhere: for a repository's own entity, and equally for a
 * shape belonging to somebody else — `pg`'s `PoolConfig`, say — whose keys are
 * already optional and where the mapping is then a no-op except for the
 * `| undefined`. Two aliases for one type would only be two things to keep in
 * step.
 */
export type PartialInput<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * What a column accepts on the way in, given what it reads back as.
 *
 * Timestamps and dates come out of `pg` as a `Date`, and are declared so. On
 * the way in either is fine — the driver sends a Date as ISO text, and Postgres
 * parses an ISO string the same way — and code written against the old
 * `string` typing passes `toISOString()` everywhere. Accepting both keeps all
 * of that compiling while the read side tells the truth.
 */
export type Writable<V> = V extends Date ? Date | string : V;

/** {@link PartialInput}, with {@link Writable} per column. For insert, update and upsert. */
export type WriteInput<T> = { [K in keyof T]?: Writable<T[K]> | undefined };
