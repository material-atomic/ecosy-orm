/* Timestamps read back as Date — which is what they always were at run time,
   while the type said string — and writes accept either. */
import { orm, connect, section, eq, done } from "./_harness.mjs";
const { Entity, createRepository } = orm;
await connect();

const Ev = Entity.create("dt_event", { columns: {
  id: { type: "SERIAL", primaryKey: true },
  at: { type: "TIMESTAMPTZ", notNull: true },
  day: { type: "DATE" },
} });
const events = createRepository(Ev);
await events.syncSchema();

section("reads are Date, writes take Date or string");
const a = await events.insert({ at: new Date("2026-09-11T10:00:00.000Z") });
const b = await events.insert({ at: "2026-09-11T11:00:00.000Z", day: "2026-09-11" });
eq("TIMESTAMPTZ reads back as a Date", a.at instanceof Date, true);
eq("DATE reads back as a Date", b.day instanceof Date, true);
eq("a string written reads back as the same instant", b.at.toISOString(), "2026-09-11T11:00:00.000Z");
await events.update({ id: a.id }, { at: "2026-09-12T00:00:00.000Z" });
eq("update takes a string", (await events.findOne({ where: { id: a.id } })).at.toISOString(), "2026-09-12T00:00:00.000Z");
eq("where takes a Date", (await events.find({ where: { at: new Date("2026-09-11T11:00:00.000Z") } })).length, 1);

await done();
