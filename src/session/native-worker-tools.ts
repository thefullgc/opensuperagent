import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Skill, ToolCallCommand } from "@tomsun28/pizza";

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve existing parents before checking paths for files that may be created. */
function realPath(path: string): string {
  // lstat also detects a dangling symlink. realpath must fail in that case
  // so writes cannot follow the link to a missing file outside the workspace.
  if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync.native(path);
  const parent = dirname(path);
  if (parent === path) return realpathSync.native(path);
  return join(realPath(parent), basename(path));
}

function assertInScope(path: string, roots: string[]): void {
  const target = realPath(path);
  if (!roots.some((root) => isWithin(root, target)))
    throw new Error(`Path escapes workspace: ${path}`);
}

/** Match the paths Pizza's file commands resolve from their parsed arguments. */
function fileCommandPath(cwd: string, path: string, read: boolean): string {
  const unprefixed = path.replace(/^@/, "").replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  const expanded = unprefixed === "~" || unprefixed.startsWith("~/")
    ? homedir() + unprefixed.slice(1)
    : unprefixed;
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  if (!read) return absolute;

  // The SDK's read command tries alternate spellings for macOS filenames.
  const nfd = absolute.normalize("NFD");
  return [
    absolute,
    absolute.replace(/ (AM|PM)\./gi, "\u202F$1."),
    nfd,
    absolute.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ].find((candidate) => existsSync(candidate)) ?? absolute;
}

/** Check the SDK's parsed arguments immediately before native CLI execution. */
export function workerCliGuard(cwd: string, skills: Skill[], allowShell: boolean) {
  const workspace = realpathSync.native(cwd);
  const snapshots = skills.map((skill) => realpathSync.native(skill.baseDir));

  return (input: string, command?: ToolCallCommand): void => {
    if (!allowShell && !/^_[a-z_]+(?=\s|$)/i.test(input.trimStart()))
      throw new Error("Shell commands are not permitted by this Worker");
    if (command?.source !== "builtin" || command.params === undefined) return;

    if (command.name === "_read" || command.name === "_write" || command.name === "_edit") {
      const { path } = command.params as { path: string };
      const read = command.name === "_read";
      assertInScope(fileCommandPath(cwd, path, read), read ? [workspace, ...snapshots] : [workspace]);
    }

    if (command.name === "_skill") {
      const { action, name, file } = command.params as { action: string; name?: string; file?: string };
      const skill = skills.find((skill) => skill.name === name && !skill.disableModelInvocation);
      if (skill && action === "load") assertInScope(skill.filePath, snapshots);
      if (skill && action === "read" && file)
        assertInScope(resolve(skill.baseDir, file), [realpathSync.native(skill.baseDir)]);
    }
  };
}
