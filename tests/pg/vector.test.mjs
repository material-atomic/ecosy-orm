/* @ecosy/orm/vector against a real pgvector. Needs a server where the `vector`
   extension is available to install — the pgvector/pgvector images are. The
   file fails when it is not, rather than skipping: a vector suite that ran
   nothing proves nothing. */
import { orm, PgDriver, connect, section, eq, rejects, logs, said, done } from "./_harness.mjs";
const { DataSource, Entity, createRepository } = orm;
const { vector, halfvec, sparsevec, bit, hnsw, ivfflat, nearest, vectorText } =
  await import(new URL("../../dist/vector/index.mjs", import.meta.url).href);

const url = process.env.TEST_DATABASE_URL;
const db = await connect(undefined, { extensions: ["vector"] });

const available = (await db.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).rowCount;
if (!available) {
  console.error("  ✗ this server has no pgvector to install. Run the pg tests against pgvector/pgvector:pg18 (or any server with the extension).");
  process.exit(1);
}

const oid = async (name) => (await db.query(`SELECT oid::int AS oid FROM pg_class WHERE relname = $1`, [name])).rows[0]?.oid ?? null;
const retyped = () => logs.some((line) => /ALTER COLUMN .* TYPE/.test(line));

const Messages = Entity.create("vt_messages", {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
    projectId: { type: "TEXT", name: "project_id", notNull: true },
    content: { type: "TEXT", notNull: true },
    embedding: vector(3),
    summary: halfvec(3),
    keywords: sparsevec(5),
    signature: bit(4),
    deletedAt: { type: "TIMESTAMPTZ", name: "deleted_at" },
  },
  indexes: [
    { name: "vt_messages_project_idx", columns: ["projectId"] },
    hnsw("vt_messages_embedding_hnsw", "embedding", { distance: "cosine", m: 8, efConstruction: 32 }),
    hnsw("vt_messages_keywords_hnsw", "keywords", { kind: "sparsevec", distance: "l2" }),
    hnsw("vt_messages_signature_hnsw", "signature", { kind: "bit", distance: "hamming" }),
  ],
  softDelete: "deletedAt",
});

section("columns and indexes of all four kinds, across boots");
const messages = createRepository(Messages);
await messages.syncSchema();
eq("the driver's `extensions` installed pgvector before the table", said(/ran: CREATE EXTENSION IF NOT EXISTS "vector"/), true);
const formatted = (await db.query(
  `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
    WHERE a.attrelid = 'vt_messages'::regclass AND a.attname IN ('embedding','summary','keywords','signature') ORDER BY a.attnum`,
)).rows.map((r) => `${r.attname} ${r.t}`);
eq("column types as declared", formatted, ["embedding vector(3)", "summary halfvec(3)", "keywords sparsevec(5)", "signature bit(4)"]);
const indexDef = (await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'vt_messages_embedding_hnsw'`)).rows[0]?.indexdef ?? "";
eq("HNSW index with its class and parameters", /USING hnsw \(embedding vector_cosine_ops\) WITH \(m='8', ef_construction='32'\)/.test(indexDef), true);

const first = {
  table: await oid("vt_messages"),
  embedding: await oid("vt_messages_embedding_hnsw"),
  keywords: await oid("vt_messages_keywords_hnsw"),
  signature: await oid("vt_messages_signature_hnsw"),
};
logs.length = 0;
await messages.syncSchema();
await messages.syncSchema();
eq("two more boots: no column retyped", retyped(), false);
eq("…no index rebuilt", [await oid("vt_messages"), await oid("vt_messages_embedding_hnsw"), await oid("vt_messages_keywords_hnsw"), await oid("vt_messages_signature_hnsw")],
  [first.table, first.embedding, first.keywords, first.signature]);
eq("…and nothing kept, dropped or recreated", said(/kept \d|Dropping|Recreating/), false);

await DataSource.end();
await DataSource.initialize(PgDriver({ connectionString: url, extensions: ["vector"], sync: { mode: "mirror" } }));
logs.length = 0;
await createRepository(Messages).syncSchema();
eq("mirror mode keeps a declared HNSW index", [await oid("vt_messages_embedding_hnsw"), said(/Dropping/)], [first.embedding, false]);

section("values in and out");
const repo = createRepository(Messages);
const alpha = await repo.insert({
  projectId: "p1", content: "alpha",
  embedding: [1, 0, 0], summary: [0.5, 0.25, 0],
  keywords: { indices: [4, 0], values: [2, 1], dimensions: 5 },
  signature: "1010",
});
eq("vector reads back as number[]", alpha.embedding, [1, 0, 0]);
eq("halfvec reads back as number[]", alpha.summary, [0.5, 0.25, 0]);
eq("sparsevec reads back 0-based, in index order", alpha.keywords, { indices: [0, 4], values: [1, 2], dimensions: 5 });
eq("bit reads back as text", alpha.signature, "1010");
eq("stored in pgvector's own text form",
  (await db.query(`SELECT embedding::text AS e, keywords::text AS k FROM vt_messages WHERE id = $1`, [alpha.id])).rows[0],
  { e: "[1,0,0]", k: "{1:1,5:2}/5" });
eq("find decodes too", (await repo.findOne({ where: { id: alpha.id } }))?.embedding, [1, 0, 0]);
await rejects("a vector of the wrong length is refused by the column", () =>
  repo.insert({ projectId: "p1", content: "short", embedding: [1, 2] }), /expected 3 dimensions/);
await rejects("a non-finite element is refused before any SQL", () =>
  repo.insert({ projectId: "p1", content: "nan", embedding: [1, Number.NaN, 0] }), /finite number/);
await rejects("a duplicate sparse index is refused before any SQL", () =>
  repo.insert({ projectId: "p1", content: "dup", keywords: { indices: [1, 1], values: [1, 2], dimensions: 5 } }), /appears twice/);
eq("vectorText gives the form a raw query binds", [vectorText([0.5, 1]), vectorText({ indices: [2], values: [3], dimensions: 4 })], ["[0.5,1]", "{3:3}/4"]);

section("nearest");
await repo.insert([
  { projectId: "p1", content: "beta", embedding: [0.9, 0.1, 0], signature: "1011" },
  { projectId: "p1", content: "gamma", embedding: [0, 1, 0], signature: "0101" },
  { projectId: "p2", content: "delta", embedding: [1, 0, 0], signature: "1010" },
]);
const near = await nearest(Messages, { column: "embedding", to: [1, 0, 0], distance: "cosine", limit: 2, where: { projectId: "p1" } });
eq("closest first, inside the project only", near.map((m) => m.entity.content), ["alpha", "beta"]);
eq("the distance comes back, 0 for an identical direction", near[0]?.distance, 0);
eq("matches are entities, their vectors decoded", Array.isArray(near[0]?.entity.embedding), true);
eq("bit columns search by Hamming distance",
  (await nearest(Messages, { column: "signature", to: "1011", distance: "hamming", limit: 1, where: { projectId: "p1" } }))[0]?.entity.content, "beta");

await repo.delete({ content: "alpha" });
eq("a soft-deleted row is not found",
  (await nearest(Messages, { column: "embedding", to: [1, 0, 0], distance: "cosine", limit: 2, where: { projectId: "p1" } })).map((m) => m.entity.content),
  ["beta", "gamma"]);
eq("…unless withDeleted says so",
  (await nearest(Messages, { column: "embedding", to: [1, 0, 0], distance: "cosine", limit: 1, where: { projectId: "p1" }, withDeleted: true }))[0]?.entity.content,
  "alpha");

await db.query(`INSERT INTO vt_messages (project_id, content, embedding)
                SELECT 'big', 'row ' || g, ('[' || random() || ',' || random() || ',' || random() || ']')::vector
                  FROM generate_series(1, 3000) g`);
await db.query(`INSERT INTO vt_messages (project_id, content, embedding) VALUES ('tiny','t1','[1,0,0]'),('tiny','t2','[0.8,0.2,0]'),('tiny','t3','[0,0,1]')`);
await db.query(`ANALYZE vt_messages`);
const tiny = await nearest(Messages, {
  column: "embedding", to: [1, 0, 0], distance: "cosine", limit: 3, where: { projectId: "tiny" },
  hnsw: { efSearch: 10, iterativeScan: "relaxed_order" },
});
eq("a narrow filter with iterative scan still fills the limit, in order",
  [tiny.map((m) => m.entity.content), tiny.every((m, i) => i === 0 || tiny[i - 1].distance <= m.distance)],
  [["t1", "t2", "t3"], true]);
eq("settings stay inside that query's transaction", (await db.query(`SELECT current_setting('hnsw.ef_search') AS value`)).rows[0]?.value, "40");
const plan = (await db.query(`EXPLAIN SELECT id FROM vt_messages ORDER BY embedding <=> '[1,0,0]' LIMIT 5`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
eq("the declared index serves a cosine search", /Index Scan using vt_messages_embedding_hnsw/.test(plan), true);

await rejects("a distance the column kind has not is refused", () =>
  nearest(Messages, { column: "embedding", to: [1, 0, 0], distance: "hamming", limit: 1 }), /vector has no hamming distance/);
await rejects("a column that is not a vector is refused", () =>
  nearest(Messages, { column: "content", to: [1, 0, 0], distance: "l2", limit: 1 }), /is TEXT, not a vector/);
let refused = "";
try { ivfflat("x", "keywords", { kind: "sparsevec", distance: "l2" }); } catch (error) { refused = error.message; }
eq("an index pgvector has no operator class for is refused at declaration", /ivfflat has no l2 operator class for sparsevec/.test(refused), true);

section("dimensions changed: retyped once, then left");
const Dims = (n) => Entity.create("vt_dims", { columns: {
  id: { type: "UUID", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
  embedding: vector(n),
} });
await createRepository(Dims(3)).syncSchema();
logs.length = 0;
await createRepository(Dims(4)).syncSchema();
eq("vector(3) → vector(4) retypes", retyped(), true);
logs.length = 0;
await createRepository(Dims(4)).syncSchema();
eq("…and the boot after leaves it", retyped(), false);

await done();
