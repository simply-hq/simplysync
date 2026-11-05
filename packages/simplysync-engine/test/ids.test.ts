import { describe, expect, test } from "bun:test";

import { createId, createIdFromString, idToUuid, uuidToId } from "../src/index";

const ID_SHAPE = /^[A-Za-z0-9_-]{22}$/u;

describe("ids", () => {
  test("createIdFromString is deterministic and shaped like createId", async () => {
    const a = await createIdFromString("order-123/shipment");
    const b = await createIdFromString("order-123/shipment");
    const c = await createIdFromString("order-124/shipment");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(ID_SHAPE);
    expect(a.length).toBe(createId().length);
    // Pinned so a port can check its digest/truncation against the same vector.
    expect(await createIdFromString("")).toBe("47DEQpj8HBSa-_TImW-5JA");
  });

  test("uuidToId round-trips through idToUuid", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const id = uuidToId(uuid);
    expect(id).toMatch(ID_SHAPE);
    expect(idToUuid(id)).toBe(uuid);
    expect(uuidToId(uuid.toUpperCase())).toBe(id);
    expect(() => uuidToId("not-a-uuid")).toThrow(/Not a UUID/);
    expect(() => idToUuid("AAAA" as never)).toThrow(/16-byte/);
  });
});
