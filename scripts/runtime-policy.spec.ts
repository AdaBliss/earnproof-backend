import {
  checkComposePolicy,
  checkDockerfilePolicy,
  checkExportStorePolicy,
  checkRunCommandsPolicy,
  runtimePolicyIssues,
} from "./runtime-policy";

const VALID_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:20.11.1-alpine3.19 AS build
WORKDIR /app
RUN npm ci
FROM node:20.11.1-alpine3.19 AS runtime
ENV NODE_ENV=production TMPDIR=/tmp
WORKDIR /app
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 4000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/main.js"]
`;

const HARDENED_RUN = [
  "docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges:true",
  "--pids-limit 512 --tmpfs /tmp -p 4000:4000 earnproof-api:local",
].join(" ");

const VALID_STORE = `import { tmpdir } from "os";
export class FsExportArtifactStore {
  private readonly baseDir = resolve(join(tmpdir(), "earnproof-exports"));
  async write() {
    await mkdir(dirname(location), { recursive: true, mode: 0o700 });
    await writeFile(location, content, { mode: 0o600 });
  }
}
`;

describe("runtime policy gate", () => {
  describe("repository regression", () => {
    it("accepts the repository's own Dockerfile, run commands, compose file and export store", () => {
      expect(runtimePolicyIssues()).toEqual([]);
    });
  });

  describe("Dockerfile: non-root execution", () => {
    it("accepts USER node", () => {
      expect(checkDockerfilePolicy(VALID_DOCKERFILE)).toEqual([]);
    });

    it("accepts USER node:node and a numeric uid >= 1000", () => {
      expect(checkDockerfilePolicy(VALID_DOCKERFILE.replace("USER node", "USER node:node"))).toEqual([]);
      expect(checkDockerfilePolicy(VALID_DOCKERFILE.replace("USER node", "USER 1000"))).toEqual([]);
    });

    it("rejects USER root, USER 0 and a privileged numeric uid", () => {
      for (const user of ["USER root", "USER 0", "USER 999"]) {
        expect(checkDockerfilePolicy(VALID_DOCKERFILE.replace("USER node", user))).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "user" })]),
        );
      }
    });

    it("rejects a Dockerfile with no USER instruction", () => {
      const noUser = VALID_DOCKERFILE.replace("USER node\n", "");
      expect(checkDockerfilePolicy(noUser)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "user" })]),
      );
    });

    it("rejects a runtime COPY that is not owned by node", () => {
      const rootOwned = VALID_DOCKERFILE.replace(
        "COPY --from=build --chown=node:node /app/dist ./dist",
        "COPY --from=build /app/dist ./dist",
      );
      expect(checkDockerfilePolicy(rootOwned)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "writable_path" })]),
      );
    });

    it("rejects a missing TMPDIR pin and a missing STOPSIGNAL", () => {
      expect(checkDockerfilePolicy(VALID_DOCKERFILE.replace(" TMPDIR=/tmp", ""))).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "writable_path" })]),
      );
      expect(checkDockerfilePolicy(VALID_DOCKERFILE.replace("STOPSIGNAL SIGTERM\n", ""))).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "healthcheck" })]),
      );
    });
  });

  describe("Dockerfile: healthcheck", () => {
    it("rejects a missing HEALTHCHECK", () => {
      const noHealth = VALID_DOCKERFILE.replace(/HEALTHCHECK[\s\S]*?\)\)"\n/, "");
      expect(checkDockerfilePolicy(noHealth)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "healthcheck" })]),
      );
    });

    it("rejects an unbounded probe: timeout above 10s, zero retries, interval below 5s", () => {
      const slowTimeout = VALID_DOCKERFILE.replace("--timeout=5s", "--timeout=30s");
      expect(checkDockerfilePolicy(slowTimeout)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "healthcheck" })]),
      );
      const noRetries = VALID_DOCKERFILE.replace("--retries=3", "--retries=0");
      expect(checkDockerfilePolicy(noRetries)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "healthcheck" })]),
      );
      const fastInterval = VALID_DOCKERFILE.replace("--interval=30s", "--interval=1s");
      expect(checkDockerfilePolicy(fastInterval)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "healthcheck" })]),
      );
    });

    it("rejects a healthcheck that needs curl, which the runtime image does not carry", () => {
      const withCurl = VALID_DOCKERFILE.replace(
        "node -e \"fetch('http://127.0.0.1:'",
        "curl -f http://127.0.0.1:4000/api/v1/health || node -e \"fetch('http://127.0.0.1:'",
      );
      expect(checkDockerfilePolicy(withCurl)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "healthcheck" })]),
      );
    });
  });

  describe("Dockerfile: privilege escalation", () => {
    it("rejects --privileged and cap-add anywhere in the image definition", () => {
      const privileged = `${VALID_DOCKERFILE}\n# RUN --privileged\n`;
      expect(checkDockerfilePolicy(privileged)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "privileged" })]),
      );
    });
  });

  describe("documented docker run commands", () => {
    it("accepts a fully hardened run command", () => {
      expect(checkRunCommandsPolicy(`\`\`\`bash\n${HARDENED_RUN}\n\`\`\``)).toEqual([]);
    });

    it("rejects a run command missing --read-only, --cap-drop=ALL or its /tmp tmpfs", () => {
      for (const missing of [
        HARDENED_RUN.replace(" --read-only", ""),
        HARDENED_RUN.replace(" --cap-drop=ALL", ""),
        HARDENED_RUN.replace(" --tmpfs /tmp", ""),
        HARDENED_RUN.replace(" --pids-limit 512", ""),
      ]) {
        expect(checkRunCommandsPolicy(missing)).not.toEqual([]);
      }
    });

    it("rejects --privileged, --cap-add and npm run inside a documented run command", () => {
      for (const bad of [
        `${HARDENED_RUN} --privileged`,
        `${HARDENED_RUN} --cap-add=SYS_ADMIN`,
        "docker run --rm --read-only earnproof-api:local npm run prisma:migrate:deploy",
      ]) {
        expect(checkRunCommandsPolicy(bad)).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "privileged" })]),
        );
      }
    });

    it("rejects docs with no docker run command to check, so the gate cannot pass vacuously", () => {
      expect(checkRunCommandsPolicy("no commands here")).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "run_command" })]),
      );
    });
  });

  describe("compose file", () => {
    it("rejects privileged mode and added capabilities", () => {
      expect(checkComposePolicy("services:\n  api:\n    privileged: true\n")).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "privileged" })]),
      );
      expect(checkComposePolicy("services:\n  api:\n    cap_add:\n      - SYS_ADMIN\n")).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "capabilities" })]),
      );
    });

    it("rejects a read-only service with no tmpfs writable path", () => {
      expect(checkComposePolicy("services:\n  api:\n    read_only: true\n")).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "writable_path" })]),
      );
    });
  });

  describe("export artifact store", () => {
    it("accepts a tmpdir-based store with 0700 directories and 0600 files", () => {
      expect(checkExportStorePolicy(VALID_STORE)).toEqual([]);
    });

    it("rejects a default outside the OS temp dir and an absolute /app write path", () => {
      const outsideTmp = VALID_STORE.replace(
        'join(tmpdir(), "earnproof-exports")',
        '"/app/earnproof-exports"',
      );
      expect(checkExportStorePolicy(outsideTmp)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "export_store" })]),
      );
    });

    it("rejects a staging directory created without mode 0700", () => {
      const looseDir = VALID_STORE.replace("{ recursive: true, mode: 0o700 }", "{ recursive: true }");
      expect(checkExportStorePolicy(looseDir)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "export_store" })]),
      );
    });
  });
});
