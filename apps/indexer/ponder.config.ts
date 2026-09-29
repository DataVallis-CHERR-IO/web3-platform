import { createConfig } from "ponder";
import { http } from "viem";

export default createConfig({
  networks: {
    polygonAmoy: {
      chainId: 80002,
      transport: http(
        process.env.PONDER_RPC_URL_80002 ?? "https://rpc-amoy.polygon.technology"
      ),
    },
  },
  contracts: {},
});
