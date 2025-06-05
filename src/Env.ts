export interface Env {
	ETH_WS_RPC_URL: string;
	ETH_RPC_URL: string;
	ADDRESS: string;
	PRIVATE_KEY: string;
	MINTER_ADDRESS: string;
	ERC2771_FORWARDER_ADDRESS: string;
	RELAYER_URL: string;
	GAME_CONTRACT_ADDRESS: string;
	EVENT_LISTENER: DurableObjectNamespace;
	BOT: DurableObjectNamespace;
}
