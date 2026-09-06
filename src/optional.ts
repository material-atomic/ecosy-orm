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
 * key and an undefined one identically anyway — a column set to `undefined` is
 * simply not written.
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
