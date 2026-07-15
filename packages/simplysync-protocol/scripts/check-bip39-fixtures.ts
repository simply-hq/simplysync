// GitHub secret scanning and Gitleaks do not reliably identify BIP39 phrases.
// Scan both the checked-out tree and every reachable Git object so a phrase
// cannot be hidden in an earlier commit and removed at the branch tip.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = join(PACKAGE_ROOT, "..", "..");

const APPROVED_FIXTURE_HASHES = new Set([
  // Official BIP39 vectors used by protocol and native conformance tests.
  "69be79ef3c28f55d7cb84db2dd3c18dfff45eeefebd09b8c5f7f3489b8ba09ac",
  "c557eec878dfd852ba3f88087c4f350f09c55537ab5e549c3cd14320ec3cef38",
  "e96bfc1d78867126dadff72e64807301e9bb837bcf329c86976647e529520528",
]);

// A revoked application recovery phrase must never be treated as a fixture.
// Keeping only its one-way fingerprint makes accidental reintroduction fail
// with a clear diagnostic without storing or printing the phrase itself.
const REVOKED_PHRASE_HASHES = new Set([
  "aa3a0ccbfdb465fa6c66df25ccb397d2d9a8ef799b46175a26a0a9021ff641d1",
]);

const VALID_WORD_COUNTS = [24, 21, 18, 15, 12] as const;
const BIP39_WORDS = new Set<string>(wordlist);

type Finding = {
  fingerprint: string;
  location: string;
  kind: "revoked" | "unapproved";
};

function git(args: string[], input?: string): string {
  return execFileSync("git", ["-C", REPOSITORY_ROOT, ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scanText(contents: string, location: string): Finding[] {
  const tokens = [...contents.matchAll(/[a-z]+/giu)];
  const candidates: Array<{
    end: number;
    fingerprint: string;
    start: number;
    words: number;
  }> = [];
  const isWordlistSource =
    /(?:^|\/)(?:BIP39Wordlist\.(?:swift|kt)|Bip39Wordlist\.kt)$/u.test(
      location,
    );

  for (let index = 0; index < tokens.length; index += 1) {
    for (const wordCount of VALID_WORD_COUNTS) {
      if (index + wordCount > tokens.length) continue;
      const slice = tokens.slice(index, index + wordCount);
      if (!slice.every((match) => BIP39_WORDS.has(match[0].toLowerCase()))) {
        continue;
      }

      const phrase = slice.map((match) => match[0].toLowerCase()).join(" ");
      if (!validateMnemonic(phrase, wordlist)) continue;
      const fingerprint = sha256(phrase);
      if (isWordlistSource && !REVOKED_PHRASE_HASHES.has(fingerprint)) {
        continue;
      }

      // The revoked fingerprint is checked across punctuation so splitting a
      // source literal cannot evade the gate. Other vectors must be actual
      // whitespace-separated phrases; this avoids checksum coincidences in
      // checked-in BIP39 word lists and ordinary prose.
      const whitespaceSeparated = slice.slice(0, -1).every((match, offset) => {
        const next = slice[offset + 1];
        return /^\s+$/u.test(
          contents.slice(match.index! + match[0].length, next.index!),
        );
      });
      if (!REVOKED_PHRASE_HASHES.has(fingerprint) && !whitespaceSeparated) {
        continue;
      }

      candidates.push({
        start: slice[0].index!,
        end: slice.at(-1)!.index! + slice.at(-1)![0].length,
        fingerprint,
        words: wordCount,
      });
    }
  }

  const approvedSpans = candidates.filter((candidate) =>
    APPROVED_FIXTURE_HASHES.has(candidate.fingerprint),
  );
  const reportedSpans: Array<{ end: number; start: number }> = [];
  const findings: Finding[] = [];

  for (const candidate of candidates.sort(
    (left, right) => right.words - left.words || left.start - right.start,
  )) {
    if (APPROVED_FIXTURE_HASHES.has(candidate.fingerprint)) continue;
    if (
      approvedSpans.some(
        (span) =>
          candidate.start >= span.start && candidate.end <= span.end,
      )
    ) {
      continue;
    }
    if (
      reportedSpans.some(
        (span) =>
          candidate.start >= span.start && candidate.end <= span.end,
      )
    ) {
      continue;
    }

    reportedSpans.push(candidate);
    findings.push({
      location,
      kind: REVOKED_PHRASE_HASHES.has(candidate.fingerprint)
        ? "revoked"
        : "unapproved",
      fingerprint: candidate.fingerprint.slice(0, 16),
    });
  }

  return findings;
}

if (
  [...APPROVED_FIXTURE_HASHES].some((fingerprint) =>
    REVOKED_PHRASE_HASHES.has(fingerprint),
  )
) {
  throw new Error("Approved and revoked BIP39 fixture sets overlap");
}

const findings: Finding[] = [];
const findingKeys = new Set<string>();
function addFindings(next: Finding[]): void {
  for (const finding of next) {
    const key = JSON.stringify(finding);
    if (findingKeys.has(key)) continue;
    findingKeys.add(key);
    findings.push(finding);
  }
}

// Scan the working tree as well as Git history so this also works before a
// developer commits a newly introduced phrase.
const trackedFiles = git(["ls-files", "-z"]).split("\0").filter(Boolean);
for (const file of trackedFiles) {
  let contents: string;
  try {
    contents = readFileSync(join(REPOSITORY_ROOT, file), "utf8");
  } catch {
    continue;
  }
  if (contents.includes("\0")) continue;
  addFindings(scanText(contents, `worktree:${file}`));
}

const objectEntries = git(["rev-list", "--objects", "--all"])
  .trim()
  .split("\n")
  .filter(Boolean);
const objectPaths = new Map<string, string>();
for (const entry of objectEntries) {
  const separator = entry.indexOf(" ");
  objectPaths.set(
    separator < 0 ? entry : entry.slice(0, separator),
    separator < 0 ? "" : entry.slice(separator + 1),
  );
}

const objectIds = [...objectPaths.keys()];
if (objectIds.length > 0) {
  const objectInfo = git(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    `${objectIds.join("\n")}\n`,
  )
    .trim()
    .split("\n");

  for (const line of objectInfo) {
    const [objectId, objectType, sizeText] = line.split(" ");
    if (!objectId || !["blob", "commit", "tag"].includes(objectType)) {
      continue;
    }
    if (Number(sizeText) > 50 * 1024 * 1024) continue;

    const contents = execFileSync(
      "git",
      ["-C", REPOSITORY_ROOT, "cat-file", objectType, objectId],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    if (contents.includes(0)) continue;
    const path =
      objectType === "commit"
        ? `<commit:${objectId.slice(0, 12)}>`
        : (objectPaths.get(objectId) ?? `<${objectType}>`);
    addFindings(scanText(contents.toString("utf8"), path));
  }
}

if (findings.length > 0) {
  console.error(
    `BIP39 fixture scan failed (${findings.length} finding(s)); phrases were not printed`,
  );
  for (const finding of findings.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  )) {
    console.error(
      `- ${finding.kind} phrase in ${finding.location} (sha256:${finding.fingerprint})`,
    );
  }
  process.exit(1);
}

console.log(
  `BIP39 fixture scan passed (${objectIds.length} reachable Git objects + working tree)`,
);
