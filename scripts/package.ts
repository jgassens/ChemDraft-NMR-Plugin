import { packagePlugin, parseCliArgs } from "../tools/plugin-package/package";
import { addPackageNotices } from "./package-notices";

try {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await packagePlugin(options);
  addPackageNotices(options.pluginRoot, result);
  console.log(`packaged ${result.packageName}@${result.version} (${result.pluginId})`);
  console.log(`  source: ${result.sourceCommit} (clean)`);
  console.log(`  zip: ${result.zipPath}`);
  console.log(`  checksum: ${result.checksumPath}`);
} catch (error) {
  console.error(`package-plugin: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
