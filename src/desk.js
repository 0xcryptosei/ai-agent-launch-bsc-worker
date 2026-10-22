import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { defineChain } from "viem";

export const deskAbi = parseAbi([
  "function agentCount() view returns (uint256)",
  "function getAgent(uint256 agentId) view returns (address owner, address meme, address launchWallet, uint256 credit, uint16 minScore, uint16 maxLaunchesPerDay, uint256 maxBuyWei, bytes32 queryHash, bool active, string name, string symbol, string metaUri)",
  "function spend(uint256 agentId, uint256 amount, bytes32 workId)",
  "event AgentCreated(uint256 indexed agentId, address indexed owner, address meme, string name, string symbol, string metaUri)",
]);

export const portalAbi = parseAbi([
  "function newTokenV6((string name, string symbol, string meta, uint8 dexThresh, bytes32 salt, uint8 migratorType, address quoteToken, uint256 quoteAmt, address beneficiary, bytes permitData, bytes32 extensionID, bytes extensionData, uint8 dexId, uint8 lpFeeProfile, uint16 buyTaxRate, uint16 sellTaxRate, uint64 taxDuration, uint64 antiFarmerDuration, uint16 mktBps, uint16 deflationBps, uint16 dividendBps, uint16 lpBps, uint256 minimumShareBalance, address dividendToken, address commissionReceiver, uint8 tokenVersion) params) payable returns (address token)",
  "function getTokenV5(address token) view returns ((uint8 status, uint256 reserve, uint256 circulatingSupply, uint256 price, uint8 tokenVersion, uint256 r, uint256 h, uint256 k, uint256 dexSupplyThresh, address quoteTokenAddress, bool nativeToQuoteSwapEnabled, bytes32 extensionID) state)",
]);

const local = defineChain({
  id: 31337,
  name: "Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export function chainFor(chainId) {
  if (chainId === 56) return bsc;
  return { ...local, id: chainId };
}

export function asAgent(row) {
  return {
    owner: row.owner ?? row[0],
    meme: row.meme ?? row[1],
    launchWallet: row.launchWallet ?? row[2],
    credit: row.credit ?? row[3],
    minScore: Number(row.minScore ?? row[4]),
    maxLaunchesPerDay: Number(row.maxLaunchesPerDay ?? row[5]),
    maxBuyWei: row.maxBuyWei ?? row[6],
    queryHash: row.queryHash ?? row[7],
    active: row.active ?? row[8],
    name: row.name ?? row[9],
    symbol: row.symbol ?? row[10],
    metaUri: row.metaUri ?? row[11],
  };
}

export function clients({ rpcUrl, chainId, privateKey }) {
  const chain = chainFor(chainId);
  const transport = http(rpcUrl);
  const account = privateKey ? privateKeyToAccount(privateKey) : null;
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = account ? createWalletClient({ account, chain, transport }) : null;
  return { publicClient, walletClient, account };
}
