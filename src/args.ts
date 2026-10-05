/** The command-line options every command shares a parser for. */
export interface CliArgs {
  positional: string[];
  /** `--pilot N`; `--pilot` alone is "default", meaning `cfg.pilotSize`. */
  pilot?: number | "default";
  /** `--filter key=value`, repeatable with different keys. */
  filter?: Record<string, string>;
  /** `--allow-deletions` */
  allowDeletions: boolean;
  /** `--first-run`: lets `build` run on a state that holds no items. */
  firstRun?: true;
  /** `--relays a,b` */
  relays?: string[];
  /** `--port N`, 0 to 65535 (0 lets the OS choose). */
  port?: number;
}

/** The option names present in `args`, for a command to refuse the ones it does not take. */
export function givenOptions(args: CliArgs): string[] {
  const given: string[] = [];
  if (args.pilot !== undefined) given.push("--pilot");
  if (args.filter !== undefined) given.push("--filter");
  if (args.allowDeletions) given.push("--allow-deletions");
  if (args.firstRun) given.push("--first-run");
  if (args.relays !== undefined) given.push("--relays");
  if (args.port !== undefined) given.push("--port");
  return given;
}

/**
 * Parses `--pilot [N]`, `--filter key=value`, `--allow-deletions`, `--first-run`, `--relays a,b`
 * and `--port N`.
 * Anything else starting with `-` is refused; the rest is positional.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { positional: [], allowDeletions: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--pilot": {
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          const n = Number(next);
          if (n < 1) throw new Error("--pilot needs a size of at least 1");
          args.pilot = n;
          i++;
        } else {
          args.pilot = "default";
        }
        break;
      }
      case "--filter": {
        const pair = argv[++i];
        const eq = pair?.indexOf("=") ?? -1;
        const key = pair?.slice(0, eq).trim() ?? "";
        const value = pair?.slice(eq + 1).trim() ?? "";
        if (pair === undefined || eq < 0 || key === "" || value === "") {
          throw new Error("--filter needs key=value, e.g. --filter country=US");
        }
        args.filter ??= {};
        if (Object.hasOwn(args.filter, key)) throw new Error(`--filter ${key} given twice`);
        args.filter[key] = value;
        break;
      }
      case "--allow-deletions":
        args.allowDeletions = true;
        break;
      case "--first-run":
        args.firstRun = true;
        break;
      case "--relays": {
        const names = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
        if (names.length === 0) throw new Error("--relays needs names, e.g. --relays dcosl,search");
        args.relays = names;
        break;
      }
      case "--port": {
        const value = argv[++i];
        if (value === undefined || !/^\d+$/.test(value) || Number(value) > 65535) {
          throw new Error("--port needs a port number from 0 to 65535, e.g. --port 4517");
        }
        args.port = Number(value);
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        args.positional.push(arg);
    }
  }
  return args;
}
