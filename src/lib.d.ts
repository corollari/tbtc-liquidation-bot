interface server {
  server: string;
  port: number;
  protocol: string;
}

declare module "@keep-network/tbtc.js" {
  import BN from "bn.js";

  export function withConfig(config: {
    web3: any;
    bitcoinNetwork: string;
    electrum: {
      testnet: server;
      testnetWS: server;
    };
  }): Promise<{
    Deposit: {
      withAddress(
        address: string
      ): Promise<{
        getCollateralizationPercentage(): Promise<BN>;
        getUndercollateralizedThresholdPercent(): Promise<BN>;
      }>;
    };
  }>;
}
