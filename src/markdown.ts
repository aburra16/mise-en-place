import { fieldCoverage, type Duplicate } from "./catalog.js";
import type { ChangeSummary } from "./diff.js";
import type { Tags } from "./item.js";

/** A markdown table. `|` inside a cell is escaped so it cannot break the row. */
export function table(head: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) =>
    `| ${cells.map((c) => String(c).replaceAll("|", "\\|")).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

/**
 * `text` as a markdown code span, so a name with `*`, `_` or backticks shows literally.
 * Backslash escapes do not work inside a code span, so the fence is one backtick longer than
 * the longest run inside, and padded with a space where CommonMark would otherwise eat a
 * character of the text. Line breaks become spaces, as a code span would render them anyway,
 * so a name can never start a new line of the list.
 */
export function codeSpan(text: string): string {
  const flat = text.replace(/\r\n|\r|\n/g, " ");
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const spaced = flat.startsWith(" ") && flat.endsWith(" ") && flat.trim() !== "";
  const pad = flat.startsWith("`") || flat.endsWith("`") || spaced ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
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

/**
 * The changed-fields part of a report: per tag name, how many of `total` changed items differ in
 * it (added, removed or modified), then the examples with their `d`, name and changed tag names.
 * `none` for no changed items.
 */
export function changedFieldsSection(summary: ChangeSummary, total: number): string {
  if (total === 0) return "none";
  return [
    `${total} changed item${total === 1 ? "" : "s"}. Per tag, how many of them differ from the live item (added, removed or modified):`,
    "",
    table(["tag", "changed items"], summary.counts.map(({ field, items }) => [field, items])),
    "",
    "Examples, in order of d:",
    "",
    bullets(
      summary.examples.map(
        ({ d, name, fields }) => `${codeSpan(d)}: ${name === undefined ? "(no name)" : codeSpan(name)} (${fields.join(", ")})`,
      ),
    ),
  ].join("\n");
}
