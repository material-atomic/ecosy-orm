/**
 * `@ecosy/orm/vector` from a caller's side: a vector column's property is the
 * type its transformer reads back, and nullability still follows `notNull`.
 */

import { Entity } from "../src/index";
import { bit, halfvec, hnsw, ivfflat, sparsevec, vector, type SparseVector } from "../src/vector";

const Messages = Entity.create("messages", {
  columns: {
    id: { type: "UUID", primaryKey: true, notNull: true },
    embedding: vector(1536, { notNull: true }),
    summary: halfvec(8),
    keywords: sparsevec(30000),
    signature: bit(64, { name: "signature_bits" }),
    title: { type: "TEXT" },
  },
  indexes: [
    hnsw("messages_embedding_hnsw", "embedding", { distance: "cosine", m: 16 }),
    ivfflat("messages_summary_ivfflat", "summary", { kind: "halfvec", distance: "l2", lists: 100 }),
  ],
} as const);

type Message = InstanceType<typeof Messages>;
declare const message: Message;

export const dense: number[] = message.embedding;
export const half: number[] | null = message.summary;
export const sparse: SparseVector | null = message.keywords;
export const bits: string | null = message.signature;
export const title: string | null = message.title;

// @ts-expect-error — `summary` is not notNull, so it can be null
export const halfNotNull: number[] = message.summary;

// @ts-expect-error — an embedding is numbers, not text
export const wrong: string[] = message.embedding;

// @ts-expect-error — dimensions is a number
vector("1536");
