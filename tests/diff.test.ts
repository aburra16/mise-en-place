import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deletionFor } from "../src/deletion.js";
import { contentHash, diffItems } from "../src/diff.js";
import type { Tags } from "../src/item.js";
import { selectPilot } from "../src/pilot.js";
import type { LiveItem } from "../src/state.js";

const CURATOR = "4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64";

function item(d: string, name = "X"): Tags {
  return [
    ["d", d],
    ["name", name],
  ];
}

function liveOf(tags: Tags, latestEventId = "e1"): LiveItem {
  const d = tags[0]?.[1] ?? "";
  return { d, contentHash: contentHash(tags), tagsJson: JSON.stringify(tags), latestEventId };
}

const builtMap = (...items: Tags[]) => new Map(items.map((t) => [t[0]?.[1] ?? "", t]));
const liveMap = (...items: LiveItem[]) => new Map(items.map((l) => [l.d, l]));

describe("contentHash", () => {
  it("is the sha256 hex of JSON.stringify(tags)", () => {
    const tags = item("osm-node-1");
    const expected = createHash("sha256").update(JSON.stringify(tags)).digest("hex");
    expect(contentHash(tags)).toBe(expected);
    expect(contentHash(tags)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a value or the tag order changes", () => {
    const a = item("osm-node-1", "A");
    expect(contentHash(a)).not.toBe(contentHash(item("osm-node-1", "B")));
    expect(contentHash(a)).not.toBe(contentHash([a[1]!, a[0]!]));
  });
});

describe("diffItems", () => {
  it("identical tags → unchanged", () => {
    const tags = item("osm-node-1");
    const diff = diffItems(builtMap(tags), liveMap(liveOf(tags)), { detectGone: true });
    expect(diff).toEqual({ created: [], changed: [], unchanged: 1, gone: [] });
  });

  it("changed value → changed", () => {
    const now = item("osm-node-1", "New name");
    const diff = diffItems(builtMap(now), liveMap(liveOf(item("osm-node-1", "Old name"))), {
      detectGone: true,
    });
    expect(diff).toEqual({ created: [], changed: [now], unchanged: 0, gone: [] });
  });

  it("new d → created", () => {
    const tags = item("osm-node-2");
    const diff = diffItems(builtMap(tags), liveMap(liveOf(item("osm-node-1"))), { detectGone: false });
    expect(diff.created).toEqual([tags]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(0);
  });

  it("detectGone true: live d absent from built → gone", () => {
    const kept = item("osm-node-1");
    const diff = diffItems(
      builtMap(kept),
      liveMap(liveOf(kept), liveOf(item("osm-node-9")), liveOf(item("osm-node-3"))),
      { detectGone: true },
    );
    expect(diff.gone).toEqual(["osm-node-3", "osm-node-9"]);
    expect(diff.unchanged).toBe(1);
  });

  it("detectGone false: nothing is gone", () => {
    const kept = item("osm-node-1");
    const diff = diffItems(builtMap(kept), liveMap(liveOf(kept), liveOf(item("osm-node-9"))), {
      detectGone: false,
    });
    expect(diff.gone).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("returns created and changed sorted by d, whatever the map order", () => {
    const c = [item("osm-node-3"), item("osm-node-1"), item("osm-node-2")];
    const ch = [item("osm-way-9", "new"), item("osm-way-1", "new")];
    const diff = diffItems(
      builtMap(...c, ...ch),
      liveMap(liveOf(item("osm-way-9", "old")), liveOf(item("osm-way-1", "old"))),
      { detectGone: true },
    );
    expect(diff.created.map((t) => t[0]?.[1])).toEqual(["osm-node-1", "osm-node-2", "osm-node-3"]);
    expect(diff.changed.map((t) => t[0]?.[1])).toEqual(["osm-way-1", "osm-way-9"]);
  });
});

describe("deletionFor", () => {
  it("deletionFor lists every version", () => {
    const del = deletionFor("osm-node-1", ["id1", "id2"], CURATOR);
    expect(del).toEqual({
      kind: 5,
      tags: [
        ["e", "id1"],
        ["e", "id2"],
        ["a", `39999:${CURATOR}:osm-node-1`],
        ["k", "39999"],
      ],
      content: "",
    });
  });

  it("names a repeated id once, keeping the first position", () => {
    const del = deletionFor("osm-node-1", ["id1", "id2", "id1"], CURATOR);
    expect(del.tags.filter((t) => t[0] === "e")).toEqual([
      ["e", "id1"],
      ["e", "id2"],
    ]);
  });

  it("refuses to build a deletion with no version ids", () => {
    expect(() => deletionFor("osm-node-1", [], CURATOR)).toThrow(/no event ids/);
  });
});

describe("selectPilot", () => {
  const CELLS = ["9q", "dr", "u0"];
  const CATEGORIES = ["restaurant", "cafe", "bar"];

  function pilotItem(id: number, cell: string, category: string): Tags {
    return [
      ["d", `osm-node-${id}`],
      ["category", category],
      ["btcmap-id", String(id)],
      ["g", `${cell}abcdefg`],
      ["g", `${cell}abcd`],
    ];
  }

  /** 3 two-character cells, 10 items each, categories mixed. */
  function grid(): Tags[] {
    const items: Tags[] = [];
    let id = 1;
    for (const cell of CELLS) {
      for (let i = 0; i < 10; i++) items.push(pilotItem(id++, cell, CATEGORIES[i % 3]!));
    }
    return items;
  }

  const cellOf = (t: Tags) => t.find((x) => x[0] === "g")?.[1]?.slice(0, 2);
  const categoryOf = (t: Tags) => t.find((x) => x[0] === "category")?.[1];
  const idOf = (t: Tags) => t.find((x) => x[0] === "btcmap-id")?.[1];

  it("selectPilot is deterministic and spread", () => {
    const items = grid();
    const first = selectPilot(items, 6);
    expect(selectPilot(items, 6)).toEqual(first);
    expect(selectPilot([...items].reverse(), 6)).toEqual(first);
    expect(first).toHaveLength(6);

    for (const cell of CELLS) {
      const fromCell = first.filter((t) => cellOf(t) === cell);
      expect(fromCell).toHaveLength(2);
      expect(new Set(fromCell.map(categoryOf)).size).toBe(2);
    }
  });

  it("orders each category by btcmap-id numerically, not as text", () => {
    const items = [pilotItem(100, "9q", "cafe"), pilotItem(10, "9q", "cafe"), pilotItem(9, "9q", "cafe")];
    expect(selectPilot(items, 3).map(idOf)).toEqual(["9", "10", "100"]);
  });

  it("round-robins across cells in key order", () => {
    const items = [pilotItem(1, "u0", "cafe"), pilotItem(2, "9q", "cafe"), pilotItem(3, "dr", "cafe")];
    expect(selectPilot(items, 3).map(cellOf)).toEqual(["9q", "dr", "u0"]);
  });

  it("returns every item when n exceeds the input, and none for n = 0", () => {
    const items = grid();
    expect(selectPilot(items, 1000)).toHaveLength(items.length);
    expect(selectPilot(items, 0)).toEqual([]);
  });
});
