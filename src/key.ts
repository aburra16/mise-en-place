import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";
import { getPublicKey } from "nostr-tools/pure";

/*
 * The curator's secret key lives only in the key file and, briefly, in the Uint8Array that
 * `loadKey` returns. No message in this file may contain the key in any form (raw bytes, hex,
 * nsec, ncryptsec) or the passphrase. Error messages are written from scratch for that reason:
 * the libraries' own messages are never passed on, because a bech32 checksum error repeats the
 * string it was given. Nothing here attaches a `cause`, for the same reason.
 */

/** `$MISE_KEY_FILE` (an empty value counts as unset), else `~/.config/mise-en-place/curator.key`. */
export function defaultKeyPath(): string {
  const override = process.env.MISE_KEY_FILE;
  if (override !== undefined && override !== "") return override;
  return join(homedir(), ".config", "mise-en-place", "curator.key");
}

/**
 * Reads the key file at `path` and returns the 32-byte secret key. The caller zeroes it
 * (`fill(0)`) when done.
 *
 * Refuses, in this order: a file that is missing, not a regular file, or readable by group or
 * others (`mode & 0o077`); content that is not an `nsec1…` or `ncryptsec1…` string once
 * trimmed; a wrong passphrase; and a key whose public key is not `expectedPubkey`.
 * `askPassphrase` is called only for an `ncryptsec`.
 *
 * The file is opened once and the mode is read from that descriptor, so the file that was
 * checked is the file that is read.
 */
export async function loadKey(
  path: string,
  expectedPubkey: string,
  askPassphrase: () => Promise<string>,
): Promise<Uint8Array> {
  let text: string;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `key file ${path} not found; write your key there, or set MISE_KEY_FILE to the file that holds it`,
      );
    }
    throw new Error(`cannot open key file ${path}: ${(err as NodeJS.ErrnoException).code ?? "unknown error"}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`key file ${path} is not a regular file`);
    if ((stat.mode & 0o077) !== 0) {
      const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
      throw new Error(`key file ${path} has mode ${mode}, which others can read; run chmod 600 ${path}`);
    }
    text = readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }

  const secret = await decodeSecret(path, text, askPassphrase);
  const derived = getPublicKey(secret);
  if (derived !== expectedPubkey) {
    secret.fill(0);
    throw new Error(
      `the key in ${path} does not match the config: it derives pubkey ${derived}, ` +
        `but curatorPubkey is ${expectedPubkey}`,
    );
  }
  return secret;
}

async function decodeSecret(
  path: string,
  text: string,
  askPassphrase: () => Promise<string>,
): Promise<Uint8Array> {
  if (text.startsWith("nsec1")) {
    try {
      const decoded = nip19.decode(text);
      if (decoded.type === "nsec") return decoded.data;
    } catch {
      // fall through to the message below
    }
    throw new Error(`${path} does not hold a valid secret key (the nsec is damaged)`);
  }
  if (text.startsWith("ncryptsec1")) {
    const passphrase = await askPassphrase();
    try {
      return nip49.decrypt(text, passphrase);
    } catch {
      throw new Error(`could not decrypt ${path}: wrong passphrase, or the ncryptsec is damaged`);
    }
  }
  throw new Error(
    `${path} does not hold a key: expected a Nostr secret key (bech32 "nsec") ` +
      `or an encrypted one (NIP-49 "ncryptsec")`,
  );
}

/**
 * The default passphrase prompt: on stderr, reading from the terminal with echo muted. Without
 * a TTY there is no way to keep the passphrase off the screen and out of a pipe, so it refuses
 * and tells the human to run the step themselves.
 */
export function promptPassphrase(): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("ncryptsec needs an interactive terminal: run npm run sign yourself"));
  }
  return new Promise((resolve, reject) => {
    let muted = false;
    // readline echoes what is typed to `output`; this one drops everything once `muted`.
    const output = new Writable({
      write(chunk, encoding, done) {
        if (!muted) process.stderr.write(chunk, encoding);
        done();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    let answered = false;
    rl.on("close", () => {
      if (answered) return;
      process.stderr.write("\n");
      reject(new Error("passphrase entry cancelled"));
    });
    process.stderr.write("ncryptsec passphrase: ");
    muted = true;
    rl.question("", (answer) => {
      answered = true;
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}
