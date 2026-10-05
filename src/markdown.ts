import { fieldCoverage, type Duplicate } from "./catalog.js";
import type { Tags } from "./item.js";

/** A markdown table. `|` inside a cell is escaped so it cannot break the row. */
export function table(head: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) =>
    `| ${cells.map((c) => String(c).replaceAll("|", "\\|")).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

/** A bullet list, or `none` for an empty one. */
export function bullets(lines: string[]): string {
  return lines.length === 0 ? "none" : lines.map((l) => `- ${l}`).join("\n");
}

/** The duplicate places as a bullet list: which btcmap id was kept and which dropped. */
export function duplicateList(duplicates: readonly Duplicate[]): string {
  return bullets(duplicates.map((x) => `${x.osmId}: kept btcmap ${x.kept}, dropped btcmap ${x.dropped}`));
}

/** Field coverage over `items` as a table: field, items carrying it, percentage. */
export function coverageTable(items: readonly Tags[]): string {
  if (items.length === 0) return "no items";
  return table(
    ["field", "items", "coverage"],
    fieldCoverage(items).map((c) => [c.field, c.count, `${c.pct.toFixed(1)}%`]),
  );
}

/** The first `n` items by `d`, each as a JSON array with one tag per line. */
export function samples(items: Iterable<[string, Tags]>, n = 20): string {
  const chosen = [...items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, n);
  if (chosen.length === 0) return "no items";
  return chosen
    .map(([, tags]) => ["```json", "[", tags.map((t) => `  ${JSON.stringify(t)}`).join(",\n"), "]", "```"].join("\n"))
    .join("\n\n");
}
