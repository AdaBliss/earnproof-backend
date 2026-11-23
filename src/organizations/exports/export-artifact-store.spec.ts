import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { FsExportArtifactStore } from "./export-artifact-store";

describe("FsExportArtifactStore", () => {
  let baseDir: string;
  let store: FsExportArtifactStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "earnproof-export-store-"));
    store = new FsExportArtifactStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("round-trips an archive through write, read and remove", async () => {
    const location = await store.write("01hwzxyz", Buffer.from("ciphertext"));
    expect(await readFile(location, "utf8")).toBe("ciphertext");
    await store.remove(location);
    await expect(readFile(location)).rejects.toThrow(/ENOENT/);
  });

  it("defaults under the OS temp dir, the container's only writable path", async () => {
    const defaultStore = new FsExportArtifactStore();
    const location = await defaultStore.write("01hwzxyz-default", Buffer.from("x"));
    try {
      expect(location.startsWith(join(tmpdir(), "earnproof-exports"))).toBe(true);
    } finally {
      await defaultStore.remove(location);
    }
  });

  it("creates the staging directory with mode 0700 and files with mode 0600", async () => {
    // A nested base that does not exist yet, so the store's own mkdir creates
    // it — asserting the mode of the mkdtemp parent would prove nothing.
    const nestedBase = join(baseDir, "nested", "earnproof-exports");
    const nestedStore = new FsExportArtifactStore(nestedBase);
    const location = await nestedStore.write("01hwzxyz-modes", Buffer.from("x"));
    const dirMode = (await stat(nestedBase)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const fileMode = (await stat(location)).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });

  it("refuses a job id that sanitises to nothing", async () => {
    await expect(store.write("...///", Buffer.from("x"))).rejects.toThrow(/empty id/);
  });

  it("refuses to read a path outside the base directory", async () => {
    await expect(store.read(join(baseDir, "..", "earnproof-export-store-outside.txt"))).rejects.toThrow(
      /escapes the configured base directory/,
    );
  });

  it("remove never propagates, and never deletes a path outside the base directory", async () => {
    const outside = join(tmpdir(), "earnproof-export-store-outside.txt");
    await writeFile(outside, "keep me");
    try {
      await expect(store.remove(join(baseDir, "..", "earnproof-export-store-outside.txt"))).resolves.toBeUndefined();
      expect(await readFile(outside, "utf8")).toBe("keep me");
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("removing a missing artifact is not an error", async () => {
    await expect(store.remove(join(baseDir, "missing.enc"))).resolves.toBeUndefined();
  });
});
