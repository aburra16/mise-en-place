import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deletionFor } from "../src/deletion.js";
import { changedFields, contentHash, diffItems, parseTags, summarizeChanges } from "../src/diff.js";
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

  it("never calls a held d gone: its record is still in the fetch, only malformed", () => {
    const kept = item("osm-node-1");
    const diff = diffItems(
      builtMap(kept),
      liveMap(liveOf(kept), liveOf(item("osm-node-7")), liveOf(item("osm-node-9"))),
      { detectGone: true, held: new Set(["osm-node-7"]) },
    );
    expect(diff.gone).toEqual(["osm-node-9"]);
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

describe("parseTags", () => {
  it("reads stored tags JSON", () => {
    expect(parseTags('[["d","a"],["t","x"],["t","y"]]')).toEqual([["d", "a"], ["t", "x"], ["t", "y"]]);
  });

  it("reads text that is not a list of string tags as no tags", () => {
    expect(parseTags("not json")).toEqual([]);
    expect(parseTags('{"d":"a"}')).toEqual([]);
    expect(parseTags('[["d","a"],"loose",["n",1],["ok","v"]]')).toEqual([["d", "a"], ["ok", "v"]]);
  });
});

describe("changedFields", () => {
  it("names the tags whose values differ, sorted", () => {
    const before: Tags = [["d", "a"], ["name", "Old"], ["phone", "1"], ["address", "x"]];
    const after: Tags = [["d", "a"], ["name", "New"], ["phone", "1"], ["address", "y"]];
    expect(changedFields(before, after)).toEqual(["address", "name"]);
  });

  it("counts an added tag and a removed tag as differing", () => {
    const before: Tags = [["d", "a"], ["phone", "1"]];
    const after: Tags = [["d", "a"], ["website", "https://x"]];
    expect(changedFields(before, after)).toEqual(["phone", "website"]);
  });

  it("compares a repeated tag as a group, in order", () => {
    const same: Tags = [["d", "a"], ["t", "cafe"], ["t", "austin"]];
    expect(changedFields(same, [...same])).toEqual([]);
    expect(changedFields(same, [["d", "a"], ["t", "cafe"], ["t", "austin"], ["t", "mexican"]])).toEqual(["t"]);
    expect(changedFields(same, [["d", "a"], ["t", "austin"], ["t", "cafe"]])).toEqual(["t"]);
  });

  it("is empty for identical tags, whatever order the tag names appear in", () => {
    expect(changedFields([["d", "a"], ["name", "N"]], [["name", "N"], ["d", "a"]])).toEqual([]);
  });
});

describe("summarizeChanges", () => {
  const place = (n: number, extra: Tags = []): Tags => [["d", `osm-node-${n}`], ["name", `Place ${n}`], ...extra];
  const liveFor = (...items: Tags[]) => liveMap(...items.map((t) => liveOf(t)));

  it("counts, per tag, the changed items where it differs: address on 3 items and phone on 1", () => {
    const old = [1, 2, 3, 4, 5].map((n) => place(n, [["address", "1 Main St"], ["phone", "555"]]));
    const now = old.map((tags, i) =>
      i < 3 ? place(i + 1, [["address", "2 Oak Ave"], ["phone", "555"]])
      : i === 3 ? place(4, [["address", "1 Main St"], ["phone", "556"]])
      : tags,
    );
    const changed = now.filter((tags, i) => JSON.stringify(tags) !== JSON.stringify(old[i]));

    const summary = summarizeChanges(changed, liveFor(...old));

    expect(summary.counts).toEqual([
      { field: "address", items: 3 },
      { field: "phone", items: 1 },
    ]);
  });

  it("counts added, removed and modified as differing, most items first and ties by name", () => {
    const old = [place(1, [["phone", "1"]]), place(2, [["website", "w"]]), place(3)];
    const now = [place(1, [["phone", "2"]]), place(2), place(3, [["website", "w"]])];

    const { counts } = summarizeChanges(now, liveFor(...old));

    expect(counts).toEqual([
      { field: "website", items: 2 }, // removed from 2, added to 3
      { field: "phone", items: 1 },
    ]);
  });

  it("lists the first 10 changed items as examples with d, name and the changed tag names", () => {
    const old = Array.from({ length: 12 }, (_, i) => place(i + 100, [["phone", "1"], ["address", "a"]]));
    const now = old.map((tags, i) => (i === 0 ? place(100, [["phone", "2"], ["address", "b"]]) : place(i + 100, [["phone", "2"], ["address", "a"]])));

    const summary = summarizeChanges(now, liveFor(...old));

    expect(summary.examples).toHaveLength(10);
    expect(summary.examples[0]).toEqual({ d: "osm-node-100", name: "Place 100", fields: ["address", "phone"] });
    expect(summary.examples[1]).toEqual({ d: "osm-node-101", name: "Place 101", fields: ["phone"] });
    expect(summary.examples.map((e) => e.d)).toEqual(now.slice(0, 10).map((t) => t[0]![1]));
    expect(summary.counts).toEqual([
      { field: "phone", items: 12 },
      { field: "address", items: 1 },
    ]);
    expect(summarizeChanges(now, liveFor(...old), 3).examples).toHaveLength(3);
  });

  it("takes the name from the new tags, and leaves it out when the item has none", () => {
    const summary = summarizeChanges([[["d", "osm-node-1"], ["phone", "2"]]], liveFor([["d", "osm-node-1"], ["phone", "1"]]));
    expect(summary.examples).toEqual([{ d: "osm-node-1", fields: ["phone"] }]);
  });

  it("treats an item whose live tags are unreadable as changed in every tag", () => {
    const live = liveMap({ d: "osm-node-1", contentHash: "h", tagsJson: "garbage", latestEventId: "e" });
    const summary = summarizeChanges([place(1, [["phone", "1"]])], live);
    expect(summary.counts.map((c) => c.field)).toEqual(["d", "name", "phone"]);
  });

  it("is empty when nothing changed", () => {
    expect(summarizeChanges([], liveMap())).toEqual({ counts: [], examples: [] });
  });
});
