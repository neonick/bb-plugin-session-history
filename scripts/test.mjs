import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = mkdtempSync(path.join(tmpdir(), "session-history-tests-"));
try {
  execFileSync(process.execPath, [
    path.join(root, "node_modules/typescript/bin/tsc"),
    "--outDir", output, "--noEmit", "false", "--module", "nodenext",
    "--target", "ES2022", "--skipLibCheck", "tests/context.test.ts",
  ], { cwd: root, stdio: "inherit" });
  writeFileSync(path.join(output, "package.json"), '{"type":"module"}\n');
  execFileSync(process.execPath, ["--test", path.join(output, "tests/context.test.js")], { stdio: "inherit" });
} finally {
  rmSync(output, { recursive: true, force: true });
}
