/**
 * Operator CLI for the artifact store. The store is configured through the
 * normal environment (`ARTIFACTS_DIR`), so no path or secret is needed on the
 * command line:
 *
 *   pnpm --filter @openchat/server artifacts -- evict --older-than 7 --keep 5
 *
 * The command above is a dry run; add `--apply` to delete the printed artifacts.
 */

import { runEvictCli } from "./artifacts-evict"

process.exitCode = await runEvictCli(process.argv.slice(2), process.env)
