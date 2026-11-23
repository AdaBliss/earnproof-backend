import { readFileSync } from "fs";
import { join, resolve } from "path";

/**
 * Production container runtime policy gate.
 *
 * The production image is only as hardened as its runtime defaults: it must
 * run as a non-root user, on a read-only root filesystem, with no Linux
 * capabilities and no privilege escalation, and with exactly one writable
 * path — a tmpfs-mounted /tmp. None of that is enforced by the image itself:
 * `--read-only`, `--cap-drop` and `--security-opt` are flags on the `docker
 * run` command, so a future edit to docs/deployment.md can silently drop
 * them. This gate is the lock on that contract. It is purely static — it
 * reads the Dockerfile, the documented run commands, the Compose file and
 * the one source file that writes to disk — so it runs in CI without a
 * Docker daemon and without building the image.
 *
 * The policy, in one place:
 *
 *   - USER is the base image's `node` user (uid 1000), never root, in every
 *     stage that switches user; runtime files are copied with
 *     `--chown=node:node` so nothing in /app needs a root-owned write.
 *   - Every documented `docker run` carries `--read-only`, `--tmpfs /tmp`,
 *     `--cap-drop=ALL`, `--security-opt=no-new-privileges:true` and a
 *     `--pids-limit`; none carries `--privileged`, `--cap-add`, a `-v` bind
 *     mount, or `npm run` (npm writes cache and logs under $HOME, which is
 *     read-only inside the container — the migration job runs the Prisma
 *     binary directly instead).
 *   - The healthcheck is present, bounded (timeout <= 10s, 1–5 retries,
 *     interval >= 5s, start-period set) and uses Node's built-in fetch
 *     against a /health endpoint, so it works with no writable filesystem
 *     and no extra binary in the image.
 *   - The only code path that writes to disk stages export archives under
 *     os.tmpdir()/earnproof-exports (see
 *     src/organizations/exports/export-artifact-store.ts), created on
 *     demand with mode 0700 and files at 0600. `ORGANIZATION_EXPORT_TEMP_DIR`
 *     must stay under a tmpfs mount if it is ever set.
 */

export interface RuntimePolicyIssue {
  code:
    | "user"
    | "healthcheck"
    | "privileged"
    | "capabilities"
    | "readonly"
    | "writable_path"
    | "run_command"
    | "compose"
    | "export_store";
  source: string;
  detail: string;
}

const RUNTIME_STAGE_MARKER = /FROM\s+\S+\s+AS\s+runtime\b/;
const HEALTHCHECK_TIMEOUT_MAX_S = 10;
const HEALTHCHECK_RETRIES_MAX = 5;
const HEALTHCHECK_INTERVAL_MIN_S = 5;

// Flags every documented `docker run` must carry, and tokens none may carry.
const REQUIRED_RUN_FLAGS = [
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true",
  "--pids-limit",
];
const REQUIRED_TMPFS = /--tmpfs[= ]\/?tmp\b/;
const FORBIDDEN_RUN_TOKENS = ["--privileged", "--cap-add", "npm run", "-v ", "--volume"];

function issue(
  code: RuntimePolicyIssue["code"],
  source: string,
  detail: string,
): RuntimePolicyIssue {
  return { code, source, detail };
}

export function checkDockerfilePolicy(content: string, source = "Dockerfile"): RuntimePolicyIssue[] {
  const issues: RuntimePolicyIssue[] = [];
  const lines = content.split("\n");

  // ── Non-root execution ──────────────────────────────────────────────────
  const userLines = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("USER "))
    .map((line) => line.slice("USER ".length).trim().split(/\s+/)[0]);
  if (userLines.length === 0) {
    issues.push(issue("user", source, "no USER instruction: the runtime stage must run as the non-root node user"));
  } else {
    for (const user of userLines) {
      const [nameOrUid] = user.split(":");
      if (nameOrUid === "root" || nameOrUid === "0") {
        issues.push(issue("user", source, `USER ${user} runs as root`));
      } else if (/^\d+$/.test(nameOrUid)) {
        if (Number(nameOrUid) < 1000) {
          issues.push(issue("user", source, `USER ${user} is a privileged uid (must be >= 1000)`));
        }
      } else if (nameOrUid !== "node") {
        issues.push(issue("user", source, `USER ${user} is not the base image's node user`));
      }
    }
    const lastUser = userLines[userLines.length - 1];
    const [lastNameOrUid] = lastUser.split(":");
    const lastIsNonRoot =
      lastNameOrUid === "node" || (/^\d+$/.test(lastNameOrUid) && Number(lastNameOrUid) >= 1000);
    if (!lastIsNonRoot) {
      issues.push(issue("user", source, `last USER ${lastUser} must be the non-root node user`));
    }
  }

  // ── No privilege escalation anywhere in the image definition ────────────
  for (const token of ["--privileged", "cap-add", "CAP_SYS_ADMIN", "privileged: true"]) {
    if (content.includes(token)) {
      issues.push(issue("privileged", source, `forbidden token present: ${token}`));
    }
  }

  // ── Runtime files must be owned by node, so /app never needs a write ────
  const runtimeIndex = lines.findIndex((line) => RUNTIME_STAGE_MARKER.test(line));
  if (runtimeIndex === -1) {
    issues.push(issue("user", source, "no runtime stage found"));
  } else {
    for (const line of lines.slice(runtimeIndex)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("COPY ") && !trimmed.includes("--chown=node:node")) {
        issues.push(
          issue(
            "writable_path",
            source,
            `runtime stage COPY without --chown=node:node: ${trimmed.slice(0, 80)}`,
          ),
        );
      }
    }
  }

  // ── Explicit writable path: only /tmp, via TMPDIR ───────────────────────
  if (!/TMPDIR=\/tmp\b/.test(content)) {
    issues.push(issue("writable_path", source, "TMPDIR is not pinned to /tmp in the image"));
  }

  // ── Graceful shutdown signal is explicit ────────────────────────────────
  if (!/^STOPSIGNAL\s+SIGTERM\s*$/m.test(content)) {
    issues.push(issue("healthcheck", source, "STOPSIGNAL SIGTERM is missing: shutdown must reach node as PID 1"));
  }

  // ── Bounded, dependency-free healthcheck ────────────────────────────────
  const healthcheckMatch = /HEALTHCHECK\s+((?:--\S+\s+)*)\s*\\\n?\s*CMD\s+([\s\S]*?)(?=\n\S|\n#|\n*$)/.exec(content);
  const healthcheckLine = lines.find((line) => line.trim().startsWith("HEALTHCHECK"));
  if (!healthcheckMatch && !healthcheckLine) {
    issues.push(issue("healthcheck", source, "no HEALTHCHECK instruction"));
  } else {
    const flags = healthcheckMatch?.[1] ?? "";
    const cmd = healthcheckMatch?.[2] ?? content.slice(content.indexOf("HEALTHCHECK"));
    const flagValue = (name: string): number | null => {
      const match = new RegExp(`--${name}=(\\d+)s?`).exec(flags);
      return match ? Number(match[1]) : null;
    };
    const timeout = flagValue("timeout");
    if (timeout === null) {
      issues.push(issue("healthcheck", source, "HEALTHCHECK has no --timeout"));
    } else if (timeout > HEALTHCHECK_TIMEOUT_MAX_S) {
      issues.push(
        issue("healthcheck", source, `HEALTHCHECK --timeout=${timeout}s exceeds ${HEALTHCHECK_TIMEOUT_MAX_S}s`),
      );
    }
    const retries = flagValue("retries");
    if (retries === null) {
      issues.push(issue("healthcheck", source, "HEALTHCHECK has no --retries"));
    } else if (retries < 1 || retries > HEALTHCHECK_RETRIES_MAX) {
      issues.push(
        issue("healthcheck", source, `HEALTHCHECK --retries=${retries} must be between 1 and ${HEALTHCHECK_RETRIES_MAX}`),
      );
    }
    const interval = flagValue("interval");
    if (interval === null) {
      issues.push(issue("healthcheck", source, "HEALTHCHECK has no --interval"));
    } else if (interval < HEALTHCHECK_INTERVAL_MIN_S) {
      issues.push(
        issue("healthcheck", source, `HEALTHCHECK --interval=${interval}s is below ${HEALTHCHECK_INTERVAL_MIN_S}s`),
      );
    }
    if (!/--start-period=\d+s/.test(flags)) {
      issues.push(issue("healthcheck", source, "HEALTHCHECK has no --start-period"));
    }
    if (!/\/health/.test(cmd)) {
      issues.push(issue("healthcheck", source, "HEALTHCHECK does not probe a /health endpoint"));
    }
    if (/curl|wget/.test(cmd)) {
      issues.push(issue("healthcheck", source, "HEALTHCHECK uses curl/wget, which the runtime image does not carry"));
    }
  }

  return issues;
}

/** Joins backslash-continued lines so a multi-line `docker run` reads as one command. */
function joinContinuations(content: string): string[] {
  const commands: string[] = [];
  let current = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.endsWith("\\")) {
      current += trimmed.slice(0, -1) + " ";
    } else if (current) {
      commands.push(current + line);
      current = "";
    } else {
      commands.push(line);
    }
  }
  if (current) commands.push(current);
  return commands;
}

export function checkRunCommandsPolicy(content: string, source = "docs/deployment.md"): RuntimePolicyIssue[] {
  const issues: RuntimePolicyIssue[] = [];
  const commands = joinContinuations(content).filter((line) => /(^|\s)docker run\b/.test(line));
  if (commands.length === 0) {
    issues.push(issue("run_command", source, "no documented docker run command to check"));
    return issues;
  }
  for (const command of commands) {
    const label = command.trim().slice(0, 100);
    for (const flag of REQUIRED_RUN_FLAGS) {
      if (!command.includes(flag)) {
        issues.push(issue("readonly", source, `docker run is missing ${flag}: ${label}`));
      }
    }
    if (!REQUIRED_TMPFS.test(command)) {
      issues.push(issue("writable_path", source, `docker run mounts no tmpfs on /tmp: ${label}`));
    }
    for (const token of FORBIDDEN_RUN_TOKENS) {
      if (command.includes(token)) {
        issues.push(issue("privileged", source, `docker run contains forbidden token ${token}: ${label}`));
      }
    }
    const mount = /--mount\b[^\n]*?(?=\\|\s--|\s*$)/.exec(command);
    if (mount && !/readonly/.test(mount[0])) {
      issues.push(issue("readonly", source, `docker run --mount is not readonly: ${label}`));
    }
  }
  return issues;
}

export function checkComposePolicy(content: string, source = "docker-compose.yml"): RuntimePolicyIssue[] {
  const issues: RuntimePolicyIssue[] = [];
  if (/privileged:\s*true/.test(content)) {
    issues.push(issue("privileged", source, "compose enables privileged mode"));
  }
  if (/cap_add:/.test(content)) {
    issues.push(issue("capabilities", source, "compose adds Linux capabilities"));
  }
  if (/read_only:\s*true/.test(content) && !/tmpfs:/.test(content)) {
    issues.push(issue("writable_path", source, "compose service is read-only but declares no tmpfs writable path"));
  }
  return issues;
}

export function checkExportStorePolicy(content: string, source = "src/organizations/exports/export-artifact-store.ts"): RuntimePolicyIssue[] {
  const issues: RuntimePolicyIssue[] = [];
  if (!/join\(tmpdir\(\),\s*"earnproof-exports"\)/.test(content)) {
    issues.push(
      issue("export_store", source, "export artifacts do not default under os.tmpdir()/earnproof-exports"),
    );
  }
  for (const absolute of ['"/app', '"/var', '"/home']) {
    if (content.includes(absolute)) {
      issues.push(issue("export_store", source, `export store references absolute path ${absolute}`));
    }
  }
  if (!/mode:\s*0o700/.test(content)) {
    issues.push(issue("export_store", source, "export staging directory is not created with mode 0700"));
  }
  if (!/mode:\s*0o600/.test(content)) {
    issues.push(issue("export_store", source, "export artifacts are not written with mode 0600"));
  }
  return issues;
}

export function runtimePolicyIssues(root = resolve(".")): RuntimePolicyIssue[] {
  const read = (relative: string): string | null => {
    try {
      return readFileSync(join(root, relative), "utf8");
    } catch {
      return null;
    }
  };
  const issues: RuntimePolicyIssue[] = [];
  const dockerfile = read("Dockerfile");
  if (dockerfile === null) {
    issues.push(issue("user", "Dockerfile", "Dockerfile is missing"));
  } else {
    issues.push(...checkDockerfilePolicy(dockerfile));
  }
  const deployment = read(join("docs", "deployment.md"));
  if (deployment === null) {
    issues.push(issue("run_command", "docs/deployment.md", "docs/deployment.md is missing"));
  } else {
    issues.push(...checkRunCommandsPolicy(deployment));
  }
  const compose = read("docker-compose.yml");
  if (compose === null) {
    issues.push(issue("compose", "docker-compose.yml", "docker-compose.yml is missing"));
  } else {
    issues.push(...checkComposePolicy(compose));
  }
  const store = read(join("src", "organizations", "exports", "export-artifact-store.ts"));
  if (store === null) {
    issues.push(issue("export_store", "src/organizations/exports/export-artifact-store.ts", "export artifact store is missing"));
  } else {
    issues.push(...checkExportStorePolicy(store));
  }
  return issues;
}

if (require.main === module) {
  const issues = runtimePolicyIssues();
  for (const found of issues) console.error(`${found.code}: ${found.source}: ${found.detail}`);
  if (issues.length) process.exit(1);
  console.log("Runtime policy gate passed.");
}
