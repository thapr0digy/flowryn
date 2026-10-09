import { describe, expect, test } from "bun:test";
import { ulid, ulidTime } from "../../src/util/ulid.ts";

describe("ulidTime", () => {
  test("reads back the millisecond a ULID was minted at", () => {
    expect(ulidTime("01ARYZ6S41TSV4RRFFQ69G5FAV")).toBe(1_469_918_176_385);
    const before = Date.now();
    const minted = ulidTime(ulid())!;
    expect(minted).toBeGreaterThanOrEqual(before);
  });

  test("is null for anything that is not a ULID", () => {
    expect(ulidTime("")).toBeNull();
    expect(ulidTime("waiter-1")).toBeNull();
    expect(ulidTime("01M49DV8PMA2X33ETWAEDGBP2U")).toBeNull();
  });
});
