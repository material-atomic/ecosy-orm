/**
 * pgvector for `@ecosy/orm`: column types, indexes, nearest-neighbour search.
 *
 * Everything here is built on what the core offers any type — a column
 * `transformer`, an index's `using` / `opclass` / `with`, the driver's
 * `extensions` — so the core knows nothing about vectors.
 *
 * @example
 * import { PgDriver } from "@ecosy/orm/drivers/pg";
 * import { vector, hnsw, nearest } from "@ecosy/orm/vector";
 *
 * const Messages = Entity.create("messages", {
 *   columns: {
 *     id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
 *     projectId: { type: "UUID", name: "project_id", notNull: true },
 *     embedding: vector(1536),
 *   },
 *   indexes: [hnsw("messages_embedding_hnsw", "embedding", { distance: "cosine" })],
 * } as const);
 *
 * await DataSource.entities([Messages]).initialize(PgDriver({ connectionString, extensions: ["vector"] }));
 *
 * const similar = await nearest(Messages, {
 *   column: "embedding", to: queryEmbedding, distance: "cosine", limit: 8,
 *   where: { projectId },
 *   hnsw: { iterativeScan: "relaxed_order" },
 * });
 */
import type { ColumnOptions, ColumnTransformer, FindWhereOptions, IndexOptions } from "../repository";
import type { Entity, EntityConstructor } from "../entity";
import type { Queryable } from "../drivers/types";
import { createRepository } from "../repository";
import { QueryBuilder } from "../query-builder";
import { DataSource } from "../data-source";
import { currentDialect } from "../drivers/current";

/** A dense vector, as `vector` and `halfvec` columns hold it. */
export type Vector = number[];

/**
 * A sparse vector. `indices` are 0-based, as array positions are; pgvector's
 * text form is 1-based, and the conversion is done here.
 */
export interface SparseVector {
  indices: number[];
  values: number[];
  dimensions: number;
}

/** The column types pgvector adds, plus Postgres's own `bit`, which it indexes. */
export type VectorKind = "vector" | "halfvec" | "sparsevec" | "bit";

/**
 * How closeness is measured. `ip` is pgvector's *negative* inner product, so
 * smaller still means closer. `hamming` and `jaccard` are for `bit` only.
 */
export type Distance = "l2" | "ip" | "cosine" | "l1" | "hamming" | "jaccard";

const OPERATOR: Record<Distance, string> = {
  l2: "<->",
  ip: "<#>",
  cosine: "<=>",
  l1: "<+>",
  hamming: "<~>",
  jaccard: "<%>",
};

/* What pgvector 0.8 provides, read from its catalogue: which distances each
   index method has an operator class for, per type. A combination missing here
   has no operator class, and CREATE INDEX would fail on it at boot. */
const INDEXABLE: Record<"hnsw" | "ivfflat", Record<VectorKind, readonly Distance[]>> = {
  hnsw: {
    vector: ["l2", "ip", "cosine", "l1"],
    halfvec: ["l2", "ip", "cosine", "l1"],
    sparsevec: ["l2", "ip", "cosine", "l1"],
    bit: ["hamming", "jaccard"],
  },
  ivfflat: {
    vector: ["l2", "ip", "cosine"],
    halfvec: ["l2", "ip", "cosine"],
    sparsevec: [],
    bit: ["hamming"],
  },
};

const MEASURABLE: Record<VectorKind, readonly Distance[]> = {
  vector: ["l2", "ip", "cosine", "l1"],
  halfvec: ["l2", "ip", "cosine", "l1"],
  sparsevec: ["l2", "ip", "cosine", "l1"],
  bit: ["hamming", "jaccard"],
};

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function positiveInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`[vector] ${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function finite(position: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`[vector] ${position} is ${String(value)}; every element must be a finite number`);
  }
  return value;
}

/* A string passes through untouched on every write: it is already pgvector's
   text form, which is what a caller holding one from a raw query has. */
const dense: ColumnTransformer<Vector, string> = {
  to(value) {
    if (typeof value === "string") return value;
    if (!value || typeof (value as ArrayLike<number>).length !== "number") {
      throw new TypeError(`[vector] expected an array of numbers, got ${describe(value)}`);
    }
    const list = value as ArrayLike<number>;
    const parts: string[] = [];
    for (let i = 0; i < list.length; i++) parts.push(String(finite(`element ${i}`, list[i])));
    return `[${parts.join(",")}]`;
  },
  from(stored) {
    return typeof stored === "string" ? (JSON.parse(stored) as Vector) : (stored as unknown as Vector);
  },
};

const sparse: ColumnTransformer<SparseVector, string> = {
  to(value) {
    if (typeof value === "string") return value;
    const { indices, values, dimensions } = (value ?? {}) as Partial<SparseVector>;
    if (!Array.isArray(indices) || !Array.isArray(values) || indices.length !== values.length) {
      throw new TypeError("[vector] a sparse vector needs `indices` and `values` arrays of the same length");
    }
    const size = positiveInteger("dimensions", dimensions);
    const pairs = indices.map((index, i) => {
      if (!Number.isInteger(index) || index < 0 || index >= size) {
        throw new TypeError(`[vector] index ${String(index)} is outside 0…${size - 1}`);
      }
      return [index, finite(`value ${i}`, values[i])] as const;
    });
    pairs.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < pairs.length; i++) {
      if (pairs[i]![0] === pairs[i - 1]![0]) throw new TypeError(`[vector] index ${pairs[i]![0]} appears twice`);
    }
    return `{${pairs.map(([index, v]) => `${index + 1}:${v}`).join(",")}}/${size}`;
  },
  from(stored) {
    if (typeof stored !== "string") return stored as unknown as SparseVector;
    const match = /^\{(.*)\}\/(\d+)$/.exec(stored);
    if (!match) throw new TypeError(`[vector] not a sparsevec: ${stored}`);
    const indices: number[] = [];
    const values: number[] = [];
    for (const pair of match[1] ? match[1].split(",") : []) {
      const [index, value] = pair.split(":");
      indices.push(Number(index) - 1);
      values.push(Number(value));
    }
    return { indices, values, dimensions: Number(match[2]) };
  },
};

const bits: ColumnTransformer<string, string> = {
  to(value) {
    if (typeof value !== "string" || !/^[01]*$/.test(value)) {
      throw new TypeError(`[vector] a bit value is a string of 0s and 1s, got ${describe(value)}`);
    }
    return value;
  },
  from(stored) {
    return String(stored);
  },
};

/** Everything a column can say besides its type and transformer, which the helper supplies. */
export type VectorColumnOptions = Omit<ColumnOptions, "type" | "transformer">;

function column(kind: VectorKind, dimensions: unknown, options: VectorColumnOptions | undefined, transformer: ColumnTransformer<Vector | SparseVector | string, string>) {
  positiveInteger(`${kind} dimensions`, dimensions);
  return { ...options, type: `${kind}(${dimensions as number})`, transformer };
}

/**
 * A `vector(n)` column: float32, read and written as `number[]`.
 *
 * @param dimensions The length every value has, fixed by the column.
 * @param options Anything else a column declares — `name`, `notNull`.
 */
export function vector<const Dimensions extends number, const Options extends VectorColumnOptions = {}>(
  dimensions: Dimensions,
  options?: Options,
) {
  return column("vector", dimensions, options, dense) as unknown as Options & {
    type: `vector(${Dimensions})`;
    transformer: ColumnTransformer<Vector, string>;
  };
}

/** A `halfvec(n)` column: float16 — half the storage of {@link vector}, read and written as `number[]`. */
export function halfvec<const Dimensions extends number, const Options extends VectorColumnOptions = {}>(
  dimensions: Dimensions,
  options?: Options,
) {
  return column("halfvec", dimensions, options, dense) as unknown as Options & {
    type: `halfvec(${Dimensions})`;
    transformer: ColumnTransformer<Vector, string>;
  };
}

/** A `sparsevec(n)` column: only the non-zero elements are stored. Read and written as {@link SparseVector}. */
export function sparsevec<const Dimensions extends number, const Options extends VectorColumnOptions = {}>(
  dimensions: Dimensions,
  options?: Options,
) {
  return column("sparsevec", dimensions, options, sparse) as unknown as Options & {
    type: `sparsevec(${Dimensions})`;
    transformer: ColumnTransformer<SparseVector, string>;
  };
}

/** A `bit(n)` column for binary vectors, read and written as a string of 0s and 1s. */
export function bit<const Dimensions extends number, const Options extends VectorColumnOptions = {}>(
  dimensions: Dimensions,
  options?: Options,
) {
  return column("bit", dimensions, options, bits) as unknown as Options & {
    type: `bit(${Dimensions})`;
    transformer: ColumnTransformer<string, string>;
  };
}

/** pgvector's text form of a value, for a raw query that binds one as a parameter. */
export function vectorText(value: Vector | SparseVector): string {
  return Array.isArray(value) ? dense.to(value) : sparse.to(value);
}

function operatorClass(method: "hnsw" | "ivfflat", kind: VectorKind, distance: Distance): string {
  const allowed = INDEXABLE[method][kind];
  if (!allowed.includes(distance)) {
    throw new TypeError(
      `[vector] ${method} has no ${distance} operator class for ${kind}` +
        (allowed.length ? ` — it has ${allowed.join(", ")}` : ` — ${kind} cannot use ${method}`),
    );
  }
  return `${kind}_${distance}_ops`;
}

export interface HnswOptions {
  distance: Distance;
  /** The column's type. Default `"vector"`. */
  kind?: VectorKind | undefined;
  /** Connections per layer. pgvector's default is 16. */
  m?: number | undefined;
  /** Candidate list size while building. pgvector's default is 64. */
  efConstruction?: number | undefined;
}

/**
 * An HNSW index: slower to build and larger than {@link ivfflat}, better recall
 * for the speed, and it can be created on an empty table.
 *
 * Use the same `distance` as the queries that should use it — an index built
 * for cosine does nothing for an L2 search.
 */
export function hnsw(name: string, column: string, options: HnswOptions): IndexOptions {
  const params: Record<string, number> = {};
  if (options.m !== undefined) params.m = positiveInteger("m", options.m);
  if (options.efConstruction !== undefined) params.ef_construction = positiveInteger("efConstruction", options.efConstruction);
  return {
    name,
    columns: [column],
    using: "hnsw",
    opclass: operatorClass("hnsw", options.kind ?? "vector", options.distance),
    ...(Object.keys(params).length ? { with: params } : {}),
  };
}

export interface IvfflatOptions {
  distance: Distance;
  /** The column's type. Default `"vector"`. */
  kind?: VectorKind | undefined;
  /** How many clusters. pgvector's default is 100; rows / 1000 is its starting advice up to a million rows. */
  lists?: number | undefined;
}

/**
 * An IVFFlat index: quicker to build and smaller than {@link hnsw}. Its clusters
 * come from the rows present when it is built, so build it once the table
 * holds data.
 */
export function ivfflat(name: string, column: string, options: IvfflatOptions): IndexOptions {
  return {
    name,
    columns: [column],
    using: "ivfflat",
    opclass: operatorClass("ivfflat", options.kind ?? "vector", options.distance),
    ...(options.lists !== undefined ? { with: { lists: positiveInteger("lists", options.lists) } } : {}),
  };
}

export interface NearestOptions<E extends Entity> {
  /** The vector column to search. */
  column: Extract<keyof E, string>;
  /** The query vector — a value of the column's kind, or pgvector's text form. */
  to: Vector | SparseVector | string;
  distance: Distance;
  /** How many matches, at most. */
  limit: number;
  /** Narrows the rows searched, as in `find`. */
  where?: FindWhereOptions<E> | undefined;
  withDeleted?: boolean | undefined;
  onlyDeleted?: boolean | undefined;
  /**
   * Settings for an HNSW index, applied to this query alone.
   *
   * `iterativeScan` matters whenever `where` filters: HNSW finds `efSearch`
   * candidates first and filters after, so a narrow filter — one project among
   * many — can return fewer rows than `limit` without it. `relaxed_order` can
   * return them slightly out of order; they are re-sorted here.
   */
  hnsw?: {
    efSearch?: number | undefined;
    iterativeScan?: "strict_order" | "relaxed_order" | undefined;
    maxScanTuples?: number | undefined;
  } | undefined;
  /** Settings for an IVFFlat index, applied to this query alone. */
  ivfflat?: {
    probes?: number | undefined;
    iterativeScan?: "relaxed_order" | undefined;
    maxProbes?: number | undefined;
  } | undefined;
}

export interface NearestMatch<E> {
  entity: E;
  /** By the chosen measure; smaller is closer. */
  distance: number;
}

/**
 * The rows closest to a vector, closest first.
 *
 * `where` is compiled as `find` compiles it, soft-delete scope included. The
 * distance is ordered on directly, so an index built for the same distance is
 * used. Settings go through `SET LOCAL` in a transaction of their own, so they
 * never leak to another query on the pool.
 */
export async function nearest<E extends Entity>(
  EntityClass: EntityConstructor<E>,
  options: NearestOptions<E>,
): Promise<NearestMatch<E>[]> {
  const { entityName, schema } = EntityClass;
  const declared = schema.columns[options.column];
  if (!declared) throw new TypeError(`[vector] ${entityName} has no column "${options.column}"`);

  const kind = /^(vector|halfvec|sparsevec|bit)\s*\(/i.exec(declared.type)?.[1]?.toLowerCase() as VectorKind | undefined;
  if (!kind) {
    throw new TypeError(`[vector] ${entityName}.${options.column} is ${declared.type}, not a vector, halfvec, sparsevec or bit column`);
  }
  if (!MEASURABLE[kind].includes(options.distance)) {
    throw new TypeError(`[vector] ${kind} has no ${options.distance} distance — it has ${MEASURABLE[kind].join(", ")}`);
  }
  const limit = positiveInteger("limit", options.limit);

  const dialect = currentDialect();
  const builder = new QueryBuilder<E>(entityName, schema);
  const { sql, params } = builder.buildSelect({
    where: options.where,
    withDeleted: options.withDeleted,
    onlyDeleted: options.onlyDeleted,
  });

  params.push(typeof options.to === "string" || !declared.transformer ? options.to : declared.transformer.to(options.to));
  const target = `CAST(${dialect.placeholder(params.length)} AS ${declared.type})`;
  const distance = `${dialect.quote(entityName)}.${dialect.quote(declared.name ?? options.column)} ${OPERATOR[options.distance]} ${target}`;
  const query = `${sql.replace(/^SELECT /, `SELECT ${distance} AS "__distance", `)} ORDER BY ${distance} LIMIT ${limit}`;

  const settings: string[] = [];
  const set = (name: string, value: string | number) =>
    settings.push(`SET LOCAL ${name} = ${typeof value === "number" ? value : `'${value}'`}`);
  const { hnsw: hnswSettings, ivfflat: ivfflatSettings } = options;
  if (hnswSettings?.efSearch !== undefined) set("hnsw.ef_search", positiveInteger("hnsw.efSearch", hnswSettings.efSearch));
  if (hnswSettings?.maxScanTuples !== undefined) set("hnsw.max_scan_tuples", positiveInteger("hnsw.maxScanTuples", hnswSettings.maxScanTuples));
  if (hnswSettings?.iterativeScan !== undefined) {
    if (!["strict_order", "relaxed_order"].includes(hnswSettings.iterativeScan)) {
      throw new TypeError(`[vector] hnsw.iterativeScan is "strict_order" or "relaxed_order", got ${String(hnswSettings.iterativeScan)}`);
    }
    set("hnsw.iterative_scan", hnswSettings.iterativeScan);
  }
  if (ivfflatSettings?.probes !== undefined) set("ivfflat.probes", positiveInteger("ivfflat.probes", ivfflatSettings.probes));
  if (ivfflatSettings?.maxProbes !== undefined) set("ivfflat.max_probes", positiveInteger("ivfflat.maxProbes", ivfflatSettings.maxProbes));
  if (ivfflatSettings?.iterativeScan !== undefined) {
    if (ivfflatSettings.iterativeScan !== "relaxed_order") {
      throw new TypeError(`[vector] ivfflat.iterativeScan is "relaxed_order", got ${String(ivfflatSettings.iterativeScan)}`);
    }
    set("ivfflat.iterative_scan", ivfflatSettings.iterativeScan);
  }

  const run = async (db: Queryable) => {
    for (const statement of settings) await db.query(statement);
    return (await db.query(query, params)).rows;
  };
  const rows = settings.length ? await DataSource.transaction((tx) => run(tx)) : await run(new DataSource());

  const repository = createRepository(EntityClass);
  const matches = rows.map((row: Record<string, unknown>) => {
    const { __distance, ...fields } = row;
    return { entity: EntityClass.hydrate(fields as never, repository) as E, distance: Number(__distance) };
  });

  if (hnswSettings?.iterativeScan === "relaxed_order" || ivfflatSettings?.iterativeScan === "relaxed_order") {
    matches.sort((a, b) => a.distance - b.distance);
  }
  return matches;
}
