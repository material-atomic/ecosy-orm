type Row = { id: string; nickname: string | null };
declare const maybe: string | undefined;

// What Partial produces under exactOptionalPropertyTypes.
declare function withPartial(data: Partial<Row>): void;
// @ts-expect-error nickname?: string | null — undefined is not in it.
withPartial({ id: "x", nickname: maybe });

// The same shape with undefined stated.
declare function withInput(data: { [K in keyof Row]?: Row[K] | undefined }): void;
withInput({ id: "x", nickname: maybe });

// And absence still works both ways, which is the point: nothing was widened
// except the ability to pass undefined explicitly.
withPartial({ id: "x" });
withInput({ id: "x" });
