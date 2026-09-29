export type Address = `0x${string}`;

export interface ChainConfig {
  id: number;
  name: string;
  testnet: boolean;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  usdcAddress: Address;
  chrAddress?: Address;
  blockExplorerUrl?: string;
  rpcUrls: {
    default: string;
    public?: string[];
  };
}

export const POLYGON_CHAIN_ID = 137;
export const AMOY_CHAIN_ID = 80002;
export const ANVIL_CHAIN_ID = 31337;

export const POLYGON_USDC_ADDRESS: Address = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
export const AMOY_USDC_ADDRESS: Address = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";
export const POLYGON_CHR_ADDRESS: Address = "0xfcfE798Dfb904f096c8e010F1254710E17AF1F81";
export const ETHEREUM_CHR_ADDRESS: Address = "0x385Fe0597Fb60c281b54955e7d15C07578cE745b";

// Default local mock addresses
export const LOCAL_USDC_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export const POLYGON_MAINNET: ChainConfig = {
  id: POLYGON_CHAIN_ID,
  name: "Polygon PoS",
  testnet: false,
  nativeCurrency: {
    name: "POL",
    symbol: "POL",
    decimals: 18,
  },
  usdcAddress: POLYGON_USDC_ADDRESS,
  chrAddress: POLYGON_CHR_ADDRESS,
  blockExplorerUrl: "https://polygonscan.com",
  rpcUrls: {
    default: "https://polygon-rpc.com",
  },
};

export const POLYGON_AMOY: ChainConfig = {
  id: AMOY_CHAIN_ID,
  name: "Polygon Amoy",
  testnet: true,
  nativeCurrency: {
    name: "POL",
    symbol: "POL",
    decimals: 18,
  },
  usdcAddress: AMOY_USDC_ADDRESS,
  blockExplorerUrl: "https://amoy.polygonscan.com",
  rpcUrls: {
    default: "https://rpc-amoy.polygon.technology",
  },
};

export const ANVIL_LOCAL: ChainConfig = {
  id: ANVIL_CHAIN_ID,
  name: "Anvil Local",
  testnet: true,
  nativeCurrency: {
    name: "ETH",
    symbol: "ETH",
    decimals: 18,
  },
  usdcAddress: LOCAL_USDC_ADDRESS,
  rpcUrls: {
    default: "http://127.0.0.1:8545",
  },
};
