/**
 * Manage the Shipfig GitHub connector's metadata and access policy.
 *
 *   npm run connector -- list            # list GitHub connectors (no tokens)
 *   npm run connector -- show            # show the configured connector
 *   npm run connector -- apply-policy    # restrict it to the gateway sprite + needed endpoints
 */
import { serverEnv } from "@/lib/env";
import { getConnection, listConnections, recommendedGitHubPolicy, updateAccessPolicy } from "@/lib/sprites/connections";

async function main() {
  const [command = "list"] = process.argv.slice(2);
  switch (command) {
    case "list": {
      const connections = await listConnections("github");
      if (connections.length === 0) {
        console.log("No GitHub connectors. Add one at https://sprites.dev → Connectors → Add connector → GitHub.");
      }
      for (const c of connections) {
        console.log(`${c.id}\t${c.provider_account_name ?? "?"}\tscopes=${c.scopes ?? "?"}\tpolicy=${JSON.stringify(c.access_policy ?? null)}`);
      }
      break;
    }
    case "show": {
      const c = await getConnection(serverEnv().SHIPFIG_GITHUB_CONNECTION_ID);
      console.log(JSON.stringify({ ...c, usage_snippet: undefined }, null, 2));
      break;
    }
    case "apply-policy": {
      const env = serverEnv();
      const policy = recommendedGitHubPolicy(env.SHIPFIG_GATEWAY_SPRITE);
      await updateAccessPolicy(env.SHIPFIG_GITHUB_CONNECTION_ID, policy);
      console.log(`Applied policy to ${env.SHIPFIG_GITHUB_CONNECTION_ID}:\n${JSON.stringify(policy, null, 2)}`);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(2);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
